'use strict';
const express=require('express');
const {authenticate}=require('../middleware/auth');
const {rejectContextOverrides}=require('./rebuild');
const {respondQboError}=require('../modules/qbo-error');
function createBusinessAgentRouter({records={},service=()=>require('../modules/business-agent-service').getBusinessAgentService(),provider=()=>require('../modules/ai-provider')}={}){
  const router=express.Router();router.use(authenticate,rejectContextOverrides,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use((req,res,next)=>Object.keys(req.query).length?res.status(400).json({error:'Business-agent controls do not accept query overrides.'}):next());
  const action=work=>async(req,res)=>{try{res.json({data:await work(req)});}catch(error){if(error.qboStage==='api'&&respondQboError(res,error))return;const known=/^(BUSINESS_|GENERAL_WRITE_)/.test(error.code||''),status=known&&[400,403,404,409].includes(error.status)?error.status:500;res.status(status).json({error:status===500?'Business monitoring could not be read. Saved controls and activity are retained.':error.message,code:known?error.code:'BUSINESS_AGENT_UNAVAILABLE',errorDetail:require('../modules/business-error-detail').businessErrorDetail(error)});}};
  const withProvider = async (state, refresh = false) => {
    // Host login health is distinct from plan quota and never dispatches a model/tool call.
    const health = await provider().getStatus({ refresh, cached: !refresh });
    return { ...state, usage: { ...state.usage, providerStatus: health.providerStatus, codex: health.codex } };
  };
  router.get('/',action(async req=>withProvider(await service().status(req.user))));
  router.get('/blockers',action(req=>service().blockers(req.user)));
  router.get('/live',action(req=>service().live(req.user)));
  // Review session transcripts. The cursor travels in the path (polling) or Last-Event-ID (stream), never a query.
  router.get('/transcripts',action(req=>service().transcripts(req.user)));
  router.get('/transcripts/stream',async(req,res)=>{
    try{await service().transcriptStream(req.user,{cursor:require('../modules/business-agent-transcript').parseCursor(req.get('Last-Event-ID'))},req,res);}
    catch(error){if(res.headersSent){if(!res.writableEnded)res.end();return;}const known=/^BUSINESS_/.test(error.code||''),status=[400,403,404,409,429].includes(error.status)?error.status:500;res.status(status).json({error:status===500?'The live review stream is unavailable. Saved activity is retained.':error.message,code:known?error.code:'BUSINESS_AGENT_UNAVAILABLE'});}
  });
  router.get('/transcripts/:attemptId/after/:seq',action(req=>service().transcript(req.user,req.params.attemptId,/^\d{1,6}$/.test(req.params.seq)?Number(req.params.seq):-1)));
  router.get('/tools',action(()=>require('../modules/business-agent-catalog').agentToolCatalog()));
  router.post('/control',action(async req=>{
    const state = await service().control(req.user,req.body);
    return req.body?.command === 'retry-plan-limit' ? withProvider(state, true) : state;
  }));
  const ownerRecords = createOwnerRecordActions(records);
  router.get('/records/options', action(req => ownerRecords.options(req.user)));
  router.post('/records/choices', action(req => ownerRecords.choices(req.user, req.body)));
  router.post('/records/prepare', action(req => ownerRecords.prepare(req.user, req.body)));
  router.get('/records/result/:runId', action(req => ownerRecords.result(req.user, req.params.runId)));
  router.post('/records/execute', action(req => ownerRecords.execute(req.user, req.body)));
  return router;
}
// Owner UI adapter only. The governed service remains the sole writer.
function createOwnerRecordActions(options = {}) {
  const { ENTITIES, entitySchema } = require('../modules/qbo-entity-schema');
  const reject = (message, status = 400) => { throw Object.assign(new Error(message), { status, code: 'BUSINESS_OWNER_RECORD_REFUSED' }); };
  const shape = (input, keys) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) reject('Unsupported record request fields.'); };
  const resolve = options.resolveContext || (user => require('../modules/rebuild-context').createContextService().resolve(user));
  const accessFor = options.accessFor || require('../modules/business-runtime-access').createBusinessRuntimeAccess;
  const runs = () => options.Runs || require('../models/GeneralWriteRun');
  async function bind(user, action) {
    const ownerId = String(user?.id || ''), actorId = String(user?.actorId || user?.id || '');
    if (!/^[a-f0-9]{24}$/.test(ownerId) || actorId !== ownerId) reject('Only the connected company owner can record business activity.', 403);
    const context = await resolve(user);
    if (!context.connection?.connected) reject('Connect a company before recording activity.', 409);
    const scope = require('../modules/qbo-write-contract').scoped({ environment: context.environment, realmId: context.connection.realmId, connectionId: context.connection.connectionId });
    const access = accessFor({ ownerId, actorId }); await access.authorize(scope, action);
    return { scope, ownerId, actorId, access, companyName: context.connection.companyName || 'Connected company' };
  }
  const general = bound => options.generalFor ? options.generalFor(bound) : require('../modules/general-write-service').createDefaultGeneralWrite({ access: bound.access });
  const scopedRun = async (bound, runId) => {
    if (!/^[a-f0-9]{24}$/.test(runId || '')) reject('A saved record plan is required.');
    const run = await runs().findOne({ _id: runId, ...bound.scope, ownerId: bound.ownerId, actorId: bound.actorId, agentAuthority: null }).maxTimeMS(3000).lean();
    if (!run || run.contract !== 'general-write-v1' || !Array.isArray(run.plan?.operations) || run.plan.operations.length !== 1 || run.plan.operations.some(op => op.op !== 'create' || !ENTITIES[op.entity]?.ops.includes('create'))) reject('This owner record plan is unavailable in the selected company.', 404);
    return run;
  };
  function resultView(bound, saved) {
    const items = Object.values(saved.items || {}), batches = saved.batches || [];
    const safeToReplace = saved.status === 'needs-correction' && (!batches.length || items.length === 1 && items.every(item => item.outcome === 'rejected') && batches.every(batch => batch.state === 'answered'));
    return { scope: bound.scope, runId: String(saved._id), status: saved.status, safeToReplace, message: saved.lastError || null, items: Object.fromEntries(Object.entries(saved.items || {}).map(([ref, item]) => [ref, { entity: item.entity, outcome: item.outcome, qboId: item.qboId, fault: item.fault, next: item.next }])), records: Object.entries(saved.items || {}).filter(([, item]) => ['saved', 'mismatch'].includes(item.outcome) && item.record).map(([ref, item]) => ({ ref, entity: item.entity, qboId: item.qboId, record: item.record, outcome: item.outcome })) };
  }
  const audit = (bound, action, result) => (options.audit || (entry => require('../models/AuditLog').create(entry)))({ userId: bound.ownerId, actorUserId: bound.actorId, realmId: bound.scope.realmId, action, actionType: 'manual', tool: 'manageQboRecord', aiDriven: false, inputParams: { ...bound.scope, runId: result.runId }, outcome: result.status === 'refused' ? 'failure' : 'success', afterState: { status: result.status } });
  return {
    async options(user) {
      const bound = await bind(user, 'operations.read');
      let policy = {}, policyMessage = '';
      try {
        if (options.policyFor) policy = await options.policyFor(bound);
        else {
          const models = require('../modules/business-runtime').loadModels();
          const published = await require('../modules/business-authority').readPublishedBusiness({ ...models, scope: bound.scope });
          const { bindDatedTax, datedTaxChoice } = require('../modules/business-dated-tax');
          const day = require('../modules/business-activity-preview').businessDate(new Date());
          const mappings = published.view.mappings, dated = bindDatedTax(published.view.business, mappings);
          policy.taxCodes = Object.fromEntries([['sales', 'salesTax'], ['purchases', 'purchaseTax']].map(([direction, key]) => [direction, [String(dated ? datedTaxChoice(dated, key, day).id : mappings[key])].filter(id => /^\d+$/.test(id))]));
        }
      } catch { policyMessage = 'Published tax choices are unavailable. Preparation will explain any business prerequisites that need attention.'; }
      return { scope: bound.scope, companyName: bound.companyName, day: require('../modules/business-activity-preview').businessDate(new Date()), dispatchEnabled: general(bound).dispatchEnabled(), schemas: Object.keys(ENTITIES).filter(entity => ENTITIES[entity].ops.includes('create')).map(entity => entitySchema(entity, policy)), policyMessage };
    },
    async choices(user, input) {
      const bound = await bind(user, 'operations.read'); shape(input, ['entity', 'search', 'partyId', 'cursor']);
      const allowed = [...Object.keys(ENTITIES), 'TaxCode'];
      if (!allowed.includes(input.entity) || input.entity === 'Preferences' || (input.search != null && (typeof input.search !== 'string' || input.search.length > 100)) || (input.partyId != null && !/^\d{1,30}$/.test(input.partyId))) reject('Choose a supported record type and party.');
      const where = [{ field: 'Active', op: 'ne', value: false }];
      if (['Invoice', 'Bill', 'CreditMemo', 'VendorCredit'].includes(input.entity)) { where.push({ field: input.entity === 'CreditMemo' ? 'RemainingCredit' : 'Balance', op: 'gt', value: 0 }); if (input.partyId) where.push({ field: (['Invoice', 'CreditMemo'].includes(input.entity) ? 'CustomerRef' : 'VendorRef') + '.value', op: 'eq', value: input.partyId }); }
      if (input.search) where.push({ anyOf: ['DisplayName', 'Name', 'DocNumber'].map(field => ({ field, op: 'contains', value: input.search })) });
      const query = options.queryFor ? options.queryFor(bound) : require('../modules/business-company-query').createCompanyQuery({ Records: require('../models/CompanySyncRecord'), scope: bound.scope });
      const result = await query.run({ mode: 'find', entities: [input.entity], where, fields: ['Name', 'DisplayName', 'DocNumber', 'Balance', 'RemainingCredit', 'TotalAmt', 'Type', 'AccountType', 'CustomerRef', 'VendorRef', 'DepositToAccountRef', 'UnitPrice'], limit: 100, ...(input.cursor ? { cursor: input.cursor } : {}) });
      return { scope: bound.scope, ...result.data };
    },
    async prepare(user, input) {
      const bound = await bind(user, 'operations.preview'); shape(input, ['decisionKey', 'purpose', 'operations']);
      if (!Array.isArray(input.operations) || input.operations.length !== 1 || input.operations.some(op => op?.op !== 'create' || !ENTITIES[op.entity]?.ops.includes('create'))) reject('Record one supported new record at a time.');
      const api = general(bound);
      const result = await require('../modules/actor-context').runAsActor(bound.actorId, () => api.prepare(bound, input));
      if (result.runId) await scopedRun(bound, result.runId);
      await audit(bound, 'Owner prepared a QuickBooks record', result);
      return { scope: bound.scope, companyName: bound.companyName, ...result, dispatchEnabled: api.dispatchEnabled() };
    },
    async result(user, runId) {
      const bound = await bind(user, 'operations.read'), saved = await scopedRun(bound, runId);
      return resultView(bound, saved);
    },
    async execute(user, input) {
      const bound = await bind(user, 'operations.execute'); shape(input, ['runId', 'confirmProduction']);
      if (bound.scope.environment === 'production' && input.confirmProduction !== true) reject('Confirm the connected Production company before sending.');
      await scopedRun(bound, input.runId);
      // Mandatory intent audit before dispatch; the normal transport retains admission and outcomes.
      await audit(bound, 'Owner requested QuickBooks record execution', { runId: input.runId, status: 'requested' });
      const result = await require('../modules/actor-context').runAsActor(bound.actorId, () => general(bound).execute(bound, input.runId));
      const saved = await scopedRun(bound, input.runId);
      return { ...resultView(bound, saved), ...result };
    },
  };
}

module.exports={createBusinessAgentRouter,createOwnerRecordActions};
