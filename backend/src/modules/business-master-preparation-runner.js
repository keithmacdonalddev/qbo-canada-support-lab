'use strict';
const { scoped, denied, freezeWriteRequest } = require('./qbo-write-contract');
const { withWriteWorkflow } = require('./qbo-write-workflow');
const { createMasterQboAccess } = require('./business-master-qbo-access');
const { compileMasterEntry } = require('./business-master-preparation-plan');
const { verifiedParents } = require('./business-master-preparation-transport');
const { prepareMasterDispatchEvidence } = require('./business-master-dispatch-evidence');
const { readDraftSetup } = require('./blueprint-draft');
const { readCanadianCompany } = require('./business-country');
const { masterFailure } = require('./business-master-preparation-failure');
function createMasterPreparationRunner({ scope, ownerId, store, clientFor, authorize, readPolicy, readSetup = readDraftSetup, readCountry = readCanadianCompany, now = () => Date.now() }) {
  scope = scoped(scope);
  if (!/^[a-f0-9]{24}$/.test(ownerId || '') || [store?.claim, store?.load, store?.reserve, store?.verify, store?.finish, store?.releaseWorker, clientFor, authorize, readPolicy, readSetup, readCountry].some(value => typeof value !== 'function')) throw new TypeError('Master worker needs a durable scope and exact read/write adapters');
  const { client, read: readPhase, queryClient } = createMasterQboAccess({ scope, ownerId, authorize, clientFor });
  async function queryPhase(work) {
    await authorize(scope, 'operations.read');
    const value = await work(queryClient);
    await authorize(scope, 'operations.read');
    return value;
  }
  const result = (run, error) => ({ runId: String(run._id), state: run.state, complete: run.state === 'complete', recordCount: run.records.length, acceptedRecords: run.records.filter(row => row.qboId).length, verifiedRecords: run.records.filter(row => row.state === 'verified').length, ...(error && run.state !== 'complete' ? { needsReview: true, failure: run.lastFailure || error } : {}) });
  return async function execute(id, { resume = false } = {}) {
    let leaseToken = null, error = null, stage = 'claim';
    try {
      let run = await store.load(id);
      if (run.state === 'complete') return result(run);
      run = await store.claim(id, { resume }); leaseToken = run.leaseToken;
      for (;;) {
        run = await store.load(id);
        if (run.leaseToken !== leaseToken) throw denied('The master worker no longer holds its saved lease.');
        const row = run.records.find(value => value.state !== 'verified');
        if (!row) { stage = 'finish'; await store.finish(id, leaseToken); break; }
        if (run.stopRequested) break;
        if (row.state !== 'pending') throw denied('The saved master ordinal needs explicit recovery before another request.');
        stage = 'setup';
        const setup = await queryPhase(qbo => readSetup(qbo, scope, now));
        stage = 'country';
        const country = await queryPhase(qbo => readCountry(qbo, scope, now));
        stage = 'reserve';
        await authorize(scope, 'operations.execute');
        const qbo = await client(), policy = await readPolicy(scope);
        // Resolve parent IDs only from retained verified records. The store repeats
        // this compilation and the gate independently checks its exact bytes.
        run = await store.load(id);
        const compiled = compileMasterEntry(run.plan, row.ordinal, verifiedParents(run)), request = freezeWriteRequest(scope, 'POST', compiled.entity.toLowerCase(), compiled.payload);
        const preflight = prepareMasterDispatchEvidence({ run, ordinal: row.ordinal, requestHash: request.requestHash, setup, country, controls: policy?.periodControl, now: now() });
        run = await store.reserve(id, leaseToken, row.ordinal, preflight);
        const attempt = run.records[row.ordinal].attempts.at(-1), workflow = { version: 1, kind: 'master-preparation', runId: String(run._id), ordinal: row.ordinal, attempt: attempt.number, leaseToken };
        stage = 'dispatch';
        let dispatchError;
        try {
          await withWriteWorkflow(workflow, async ack => {
            // This acknowledgement never supplies the only durable correlation.
            const current = await store.load(id), saved = current.records[row.ordinal].attempts.at(-1);
            if (saved.number !== workflow.attempt || saved.state !== 'possibly-sent' || saved.receiptId !== ack.receiptId || saved.dispatchKey !== ack.dispatchKey || saved.requestHash !== request.requestHash) throw denied('The admitted master attempt acknowledgement changed.', true);
          }, () => qbo.apiCall('POST', compiled.entity.toLowerCase(), compiled.payload));
        } catch (caught) { dispatchError = caught; }
        run = await store.load(id);
        const saved = run.records[row.ordinal];
        // A lost response acknowledgement can still leave a confirmed saved ID.
        // Unknown/possibly-sent/refused attempts never become automatic retries.
        if (saved.state !== 'saved' || !/^\d{1,30}$/.test(saved.qboId || '')) throw dispatchError || denied('The master create has no confirmed accepted identity.', true);
        stage = 'readback';
        const body = await readPhase('operations.recover', current => current.apiCall('GET', compiled.entity.toLowerCase() + '/' + saved.qboId));
        stage = 'verify';
        await store.verify(id, row.ordinal, leaseToken, body?.[compiled.entity]);
      }
    } catch (caught) { error = masterFailure(stage, caught); }
    finally {
      if (leaseToken) { try { await store.releaseWorker(id, leaseToken, error); } catch { /* Durable lease and request barrier remain authoritative. */ } }
    }
    try { return result(await store.load(id), error); }
    catch { return { runId: id, state: 'unavailable', complete: false, needsReview: true, error: 'Current saved master progress could not be read. Refresh before taking another action.' }; }
  };
}
module.exports = { createMasterPreparationRunner };
