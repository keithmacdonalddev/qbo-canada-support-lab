'use strict';
const { randomUUID } = require('node:crypto');
const { hash, canonical } = require('./business-calendar');
const { denied } = require('./qbo-write-contract');
const { createPopulationReader } = require('./business-population-reader');
const { createPopulationCreationValidator } = require('./business-population-receipt');
const issues = require('./business-population-issues');
const ID = /^[a-f0-9]{24}$/, KEY = /^[a-f0-9]{64}$/;
function publicVerification(value) { if (!value) return null; const { runId, status, requestedAt, finishedAt, total, checked, errors, lastError, code } = value; return { runId, status, requestedAt, finishedAt, total, checked, errors, lastError, code: code || null }; }
function createPopulationVerification(deps) {
  const { models, bind, bindJob, read, transaction, fenceAccess, audit, now, publicJob, pageRows } = deps;
  const { Jobs, Records, Writers } = models, workers = new Map(); let closed = false;
  async function scopedJob(user, id, action = 'operations.read') { if (!ID.test(id || '')) throw denied('Use an exact population job.'); const bound = await bind(user, action), job = await read(Jobs, { _id: id, ...bound.scope }); if (!job || String(job.ownerId) !== bound.ownerId) throw denied('This population job is not in the active company.'); return { ...bound, job }; }
  async function list(user, id, body) {
    if (!body || Object.keys(body).sort().join(',') !== 'after,code' || (body.after !== null && !KEY.test(body.after || ''))) throw denied('Use the issue code and saved paging cursor.'); issues.assertIssueCode(body.code);
    const bound = await scopedJob(user, id), query = { ...issues.recordQuery(bound.scope, bound.job), ...(body.code === 'record-verification-failed' ? { $or:[{ 'relationshipCheck.outcome': 'error' },{state:'saved',financialProof:null}] } : { coverageGaps: { $in: [body.code] } }), ...(body.after ? { _id: { $gt: body.after } } : {}) };
    const rows = await Records.find(query,null,{singleBatch:true,batchSize:26}).sort({ _id: 1 }).limit(26).select('_id logicalKey entity qboId txnDate fingerprint receipt financialProof coverageGaps relationshipCheck issueDecisions').maxTimeMS(5000).lean();
    const visible=rows.slice(0,25),last=visible.at(-1),hasMore=rows.length>25 || (last&&await read(Records,{...query,_id:{$gt:last._id}}));
    return { scope: bound.scope, jobId: id, code: body.code, records: visible.map(row => issues.issueView(row, body.code)), next: hasMore ? String(last._id) : null };
  }
  async function start(user, id, body) {
    if (!body || !['manifestHash','code,manifestHash'].includes(Object.keys(body).sort().join(',')) || !KEY.test(body.manifestHash || '')) throw denied('Use the exact prepared manifest and optional issue group.');
    const code = body.code === undefined ? null : body.code; if (code !== null) issues.assertIssueCode(code); else if (body.code !== undefined) throw denied('Choose an existing issue group.');
    const bound = await scopedJob(user, id, 'operations.execute'); if (bound.actorId !== bound.ownerId) throw denied('Only the owner can recheck relationships.');
    await transaction(async session => {
      await fenceAccess(bound, session); const job = await read(Jobs, { _id: id, ...bound.scope }, session), writer = await read(Writers, bound.scope, session);
      const competing=await read(Jobs,{...bound.scope,_id:{$ne:id},$or:[{status:{$in:['running','stopping']}},{'verification.status':{$in:['queued','running']}}]},session);
      if(competing)throw denied('Another company job is creating or verifying records. Wait for it to finish.');
      if (job.manifestHash !== body.manifestHash || hash(job.manifest) !== job.manifestHash || ['running','stopping'].includes(job.status) || job.leaseToken || job.batch || writer?.unresolved !== null) throw denied('Finish or stop creation and settle company writes before rechecking.');
      if (['queued','running'].includes(job.verification?.status)) return;
      const selection = code === 'record-verification-failed' ? { $or: [{ 'relationshipCheck.outcome': 'error' }, { financialProof: null }] } : code ? { coverageGaps: { $in: [code] } } : { $or: [{ coverageGaps: { $in: [...issues.CODES] } }, { 'relationshipCheck.outcome': 'error' }, { 'relationshipProof.matches': true }, { financialProof: null }] };
      const candidates = await pageRows(Records, { ...issues.recordQuery(bound.scope, job), state: 'saved', ...selection }, session, '_id txnDate logicalKey');
      const targets = candidates.sort((a,b)=>a.txnDate.localeCompare(b.txnDate)||a.logicalKey.localeCompare(b.logicalKey)).map(row => String(row._id)); if (targets.length > 40000 || targets.some(id => !KEY.test(id))) throw denied('The verification selection exceeds its bound.');
      const resume=['stopped','blocked'].includes(job.verification?.status)&&Number.isInteger(job.verification.cursor)&&job.verification.cursor<job.verification.total&&Array.isArray(job.verification.targets)&&job.verification.targets.length===job.verification.total&&job.verification.targets.every(id=>KEY.test(id));
      if (resume && code !== null && code !== (job.verification.code || null)) throw denied('Resume the saved recheck before selecting another group.');
      const verification = resume?{...job.verification,status:'queued',leaseToken:null,leaseExpiresAt:null,lastError:null,finishedAt:null}:{ runId: randomUUID(), code, status: 'queued', requestedAt: new Date(now()).toISOString(), targets, total: targets.length, checked: 0, errors: 0, cursor: 0, leaseToken: null, leaseExpiresAt: null, lastError: null };
      const updated = await Jobs.findOneAndUpdate({ _id: id, ...bound.scope, revision: job.revision }, { $set: { verification }, $inc: { revision: 1 } }, { new: true, session }).lean(); if (!updated) throw denied('Population changed before recheck.');
      await audit(bound, id, resume?'relationship-recheck-resumed':'relationship-recheck-requested', { runId: verification.runId, code: verification.code || null, targetHash: hash(verification.targets), count: verification.total, cursor:verification.cursor, revision:job.revision, qboWrites: 0 }, session);
    }); kick(id); return { scope: bound.scope, job: await publicJob(await read(Jobs, { _id: id, ...bound.scope })) };
  }
  async function stop(user, id) {
    const bound = await scopedJob(user, id, 'operations.stop'); if (bound.actorId !== bound.ownerId) throw denied('Only the owner can stop a recheck.');
    await transaction(async session => { await fenceAccess(bound, session, 'operations.stop'); const job = await read(Jobs, { _id: id, ...bound.scope }, session); if (!['queued','running'].includes(job.verification?.status)) return; await Jobs.updateOne({ _id: id, ...bound.scope, revision: job.revision }, { $set: { 'verification.status': 'stopped', 'verification.finishedAt': new Date(now()).toISOString() }, $inc: { revision: 1 } }, { session }); await audit(bound, id, 'relationship-recheck-stopped', { runId: job.verification.runId, checked: job.verification.checked, revision:job.revision, qboWrites: 0 }, session); });
    return { scope: bound.scope, job: await publicJob(await read(Jobs, { _id: id, ...bound.scope })) };
  }
  async function limitation(user, id, body) {
    if (!body || Object.keys(body).sort().join(',') !== 'code,evidenceHash,reason,recordId' || !KEY.test(body.recordId || '') || !KEY.test(body.evidenceHash || '') || typeof body.reason !== 'string' || body.reason.trim().length < 5 || body.reason.length > 1000) throw denied('Select a current issue and explain the limitation in 5 to 1000 characters.'); issues.assertIssueCode(body.code);
    const bound = await scopedJob(user, id, 'operations.execute'); if (bound.actorId !== bound.ownerId) throw denied('Only the owner can document a limitation.');
    await transaction(async session => { await fenceAccess(bound, session); const currentJob = await read(Jobs, { _id: id, ...bound.scope }, session); if (['running','stopping'].includes(currentJob.status) || ['queued','running'].includes(currentJob.verification?.status)) throw denied('Wait for creation and rechecks to finish before recording a limitation.'); const row = await read(Records, { _id: body.recordId, ...issues.recordQuery(bound.scope, bound.job), state: 'saved' }, session); if (!row || !issues.issueCodes(row).includes(body.code) || issues.recordEvidence(row) !== body.evidenceHash) throw denied('The issue changed. Refresh its details before recording a limitation.');
      const decision = { evidenceHash: body.evidenceHash, reason: body.reason.trim(), recordedAt: new Date(now()).toISOString(), ownerId: bound.ownerId }, result = await Records.updateOne({ _id: row._id, ...bound.scope, revision: row.revision }, { $set: { ['issueDecisions.' + body.code]: decision }, $inc: { revision: 1 } }, { session }); if (result.matchedCount !== 1) throw denied('The issue changed during review.'); await audit(bound, id, 'relationship-limitation-recorded', { logicalKey: row.logicalKey, code: body.code, ...decision, verified: false, qboWrites: 0 }, session); });
    return { scope: bound.scope, saved: true };
  }
  async function run(id) {
    const bound = await bindJob(id), { scope, access } = bound; let job = bound.job; const runId = job.verification?.runId, token = randomUUID(), started = now(); if (!runId || !['queued','running'].includes(job.verification.status)) return;
    if (job.verification.leaseToken && Date.parse(job.verification.leaseExpiresAt) > now()) return;
    const claim = await Jobs.findOneAndUpdate({ _id: id, ...scope, revision: job.revision, 'verification.runId': runId }, { $set: { 'verification.status': 'running', 'verification.leaseToken': token, 'verification.leaseExpiresAt': new Date(now() + 600000).toISOString() }, $inc: { revision: 1 } }, { new: true }).lean(); if (!claim) return;
    try {
    const sourceClient = await access.resolveClient(scope), queue = deps.createReadQueue?.() || require('./business-population-reads').createPopulationReadQueue();
    const client = { apiCall(method, endpoint, ...args) { if (method !== 'GET' || typeof endpoint !== 'string' || !/^(?:[a-z]+[/][0-9]+$|reports[/]GeneralLedger[?])/i.test(endpoint) || endpoint.includes('://')) throw denied('Relationship verification permits scoped GET reads only.'); return sourceClient.apiCall(method, endpoint, ...args); }, query(query, control) { if (!/^SELECT [*] FROM (?:Estimate|Invoice|TimeActivity|Payment|Deposit|PurchaseOrder|Bill|SalesReceipt|BillPayment) WHERE Id IN [(]'[0-9]+'(?:,'[0-9]+')*[)] MAXRESULTS 1000$/.test(query)) throw denied('Verification requires exact saved IDs.'); return sourceClient.query(query, control); } };
    const validateCreation = createPopulationCreationValidator({ models, scope, now });
    async function fence(session) {
      await access.authorize(scope, 'operations.read', { session }); const current = await read(Jobs, { _id: id, ...scope }, session), writer = await read(Writers, scope, session), competing=await read(Jobs,{...scope,_id:{$ne:id},$or:[{status:{$in:['running','stopping']}},{'verification.status':{$in:['queued','running']}}]},session);
      if(competing)throw denied('Another company job is active.');
      if (current?.verification?.runId !== runId || current.verification.leaseToken !== token || current.verification.status !== 'running' || Date.parse(current.verification.leaseExpiresAt) <= now() || ['running','stopping'].includes(current.status) || current.leaseToken || current.batch || writer?.unresolved !== null) throw denied('Verification stopped or company activity changed.');
      if (writer.operationId) { const operation = await read(models.Runs, { _id: writer.operationId, ...scope }, session); if (operation?.leaseToken || operation?.executionRequest?.pending) throw denied('Wait for the current company operation before rechecking.'); }
      return { scope, operationId: String(writer.operationId || ''), revision: writer.revision, unresolved: null };
    }
      while (!closed && now() - started < 540000) {
        job = await read(Jobs, { _id: id, ...scope }); if (job.verification?.runId !== runId || job.verification.status !== 'running') break;
        if(hash(job.manifest)!==job.manifestHash)throw denied('The immutable verification manifest changed.');
        const selected = job.verification.targets.slice(job.verification.cursor, job.verification.cursor + 25);
        if (!selected.length) { await transaction(async session => { await fenceAccess(bound, session); await fence(session);const summary=await deps.counts(job),settled=summary.saved===summary.required&&summary.contentChecked===summary.required; await Jobs.updateOne({ _id: id, ...scope, 'verification.runId': runId, 'verification.leaseToken': token }, { $set: { 'verification.status': 'completed', 'verification.finishedAt': new Date(now()).toISOString(), 'verification.leaseToken': null, 'verification.leaseExpiresAt': null, 'verification.lastError': null,...(settled?{status:summary.coverageGaps||summary.verificationErrors?'populated-with-gaps':'populated'}:{}) } }, { session }); await audit(bound, id, 'relationship-recheck-completed', { runId, checked: job.verification.checked, errors: job.verification.errors, qboWrites: 0, verifiedCalendarAdvanced: false }, session); }); break; }
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 180000); timer.unref?.();
        try {
          const targets = await Records.find({ ...issues.recordQuery(scope, job), _id: { $in: selected }, state: 'saved' }).maxTimeMS(5000).lean(); if (targets.length !== selected.length) throw denied('The exact verification selection changed.');
          const all = new Map(targets.map(row => [row.logicalKey, row]));
          for (let depth = 0; depth < 20; depth++) {
            const size=all.size,keys=[...all.keys()],missing=[...new Set([...all.values()].flatMap(row=>row.step.dependencies.map(link=>link.logicalKey)).filter(key=>!all.has(key)))];
            if(missing.length){const parents=await pageRows(Records,{...issues.recordQuery(scope,job),logicalKey:{$in:missing},state:'saved'},null);if(parents.length!==missing.length)throw denied('A saved relationship source is missing.');for(const row of parents)all.set(row.logicalKey,row);}
            const children=await pageRows(Records,{...issues.recordQuery(scope,job),state:'saved','step.dependencies.logicalKey':{$in:keys}},null);for(const row of children)all.set(row.logicalKey,row);
            if(all.size>1000||Buffer.byteLength(JSON.stringify([...all.values()]))>64000000)throw denied('Verification neighbors exceed their record or byte bound.');
            if(all.size===size)break;if(depth===19)throw denied('Verification neighbors exceed20 levels.');
          }
          const descriptors=new Map(job.manifest.map(value=>[value.logicalKey,value]));for(const row of all.values()){const descriptor=descriptors.get(row.logicalKey);if(!descriptor||['entity','txnDate','fingerprint','intentHash'].some(key=>descriptor[key]!==row[key]))throw denied('A verification record differs from its immutable manifest.');}
          const before = await fence(), reader = createPopulationReader({ scope, jobId: id, client, records: [...all.values()], readFence: () => fence(), validateCreation, now, signal: controller.signal, readQueue: queue }); await reader.prime([...all.values()]);
          const cached = new Map(), financial = row => { if (!cached.has(row.logicalKey)) cached.set(row.logicalKey, reader.financial(row)); return cached.get(row.logicalKey); }, updates = [];
          for (const row of targets) {
            try {
              const value = await financial(row), source = JSON.parse(value.financialProof.sourceJson), linked = issues.isConversion(row) ? [row] : [...all.values()].filter(child => issues.isConversion(child) && child.step.dependencies.some(link => link.logicalKey === row.logicalKey));
              const proofs = [], childEvidence = []; for (const child of linked) { const evidence = (await financial(child)).financialProof; childEvidence.push(evidence); proofs.push(issues.relationshipProof(child, evidence, now())); }
              const strict = proofs.length > 0 && proofs.every(proof => proof.matches);
              const timeBilled = childEvidence.length > 0 && childEvidence.every(evidence => issues.hasBilledTime(evidence, row.entity === 'TimeActivity' ? row.qboId : null));
              const originalGaps = (row.coverageGaps || []).filter(code => code !== 'record-verification-failed' && !(code === 'time-invoice-billing-unverified' && timeBilled));
              const coverageGaps = [...new Set([...value.financialProof.coverageGaps, ...(!strict ? originalGaps : []), ...(!strict&&(issues.isConversion(row)||(row.entity==='Estimate'&&linked.length))?['estimate-invoice-conversion-unverified']:[])])];
              const check = { runId, checkedAt: new Date(now()).toISOString(), outcome: coverageGaps.length ? 'attention' : 'clear', snapshot: issues.snapshot(source), message: null };
              updates.push({ row, set: { financialProof: value.financialProof, coverageGaps, relationshipCheck: check, ...(issues.isConversion(row) ? { relationshipProof: proofs[0] } : {}) } });
            } catch (error) { const current=await reader.observed(row);const previous=issues.sourceOf(row);updates.push({ row, set: { relationshipCheck: { runId, checkedAt: new Date(now()).toISOString(), outcome: 'error', snapshot:issues.snapshot({compiled:row.compilation,observed:current,parents:[],children:[]}),previousObservationAt:previous?.observed?.observedAt || null, message: error.code === 'BUSINESS_READBACK_UNVERIFIED' ? error.message.slice(0,500) : 'The original receipt or current record could not be verified. Existing warnings are retained.' } } }); }
          }
          if (canonical(before) !== canonical(await fence())) throw denied('Company activity changed during verification.');
          await transaction(async session => { await fenceAccess(bound, session); if (canonical(before) !== canonical(await fence(session))) throw denied('Company activity changed before saving verification.');
            for (const update of updates) { if(update.set.relationshipProof){const proof=update.set.relationshipProof;proof.auditId=await audit(bound,id,'relationship-evidence-observed',{logicalKey:update.row.logicalKey,qboId:update.row.qboId,receiptHash:proof.receiptHash,financialEvidenceHash:proof.financialEvidenceHash,relationshipEvidenceHash:proof.evidenceHash,matches:proof.matches,observedAt:proof.observedAt,validatedAt:proof.validatedAt,qboWrites:0},session);} const result = await Records.updateOne({ _id: update.row._id, ...scope, state: 'saved', qboId: update.row.qboId, fingerprint: update.row.fingerprint, revision: update.row.revision }, { $set: update.set, $inc: { revision: 1 } }, { session }); if (result.matchedCount !== 1) throw denied('A saved issue changed during verification.'); }
            const saved = await Jobs.findOneAndUpdate({ _id: id, ...scope, 'verification.runId': runId, 'verification.leaseToken': token, 'verification.cursor': job.verification.cursor }, { $inc: { 'verification.cursor': selected.length, 'verification.checked': selected.length, 'verification.errors': updates.filter(update => update.set.relationshipCheck.outcome === 'error').length, revision: 1 }, $set: { 'verification.leaseExpiresAt': new Date(now() + 600000).toISOString() } }, { new: true, session }).lean(); if (!saved) throw denied('Another worker changed verification progress.');
            await audit(bound, id, 'relationship-recheck-group', { runId, cursor: saved.verification.cursor, records: updates.map(update => ({ logicalKey: update.row.logicalKey, outcome: update.set.relationshipCheck.outcome, gaps: update.set.coverageGaps || update.row.coverageGaps })), qboWrites: 0 }, session);
          });
        } finally { clearTimeout(timer); controller.abort(); }
      }
    } catch (error) { await Jobs.updateOne({ _id: id, ...scope, 'verification.runId': runId, 'verification.leaseToken': token, 'verification.status': 'running' }, { $set: { 'verification.status': 'blocked', 'verification.lastError': 'The recheck stopped before confirming this group. Previous warnings and saved records are retained. Retry after company activity or access is settled.' } });
    } finally { await Jobs.updateOne({ _id: id, ...scope, 'verification.runId': runId, 'verification.leaseToken': token }, { $set: { 'verification.leaseToken': null, 'verification.leaseExpiresAt': null } }); }
  }
  function kick(id) { if (closed || workers.has(id)) return; const work = Promise.resolve().then(() => run(id)).catch(() => {}).finally(() => workers.delete(id)); workers.set(id, work); }
  async function scan() { if (closed) return; const rows = await Jobs.find({ 'verification.status': { $in: ['queued','running'] } }).select('_id').limit(20).maxTimeMS(5000).lean(); for (const row of rows) kick(String(row._id)); }
  return { list, start, stop, limitation, scan, close() { closed = true; }, drain: () => Promise.allSettled([...workers.values()]) };
}
module.exports = { createPopulationVerification, publicVerification };
