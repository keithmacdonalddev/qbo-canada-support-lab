'use strict';
const express = require('express');
const {respondQboError}=require('../modules/qbo-error');
const { authenticate } = require('../middleware/auth');
// Mount beneath the existing company scope middleware; deliberately not mounted here.
// GET /, /packages/:id, /packages/:id/files/:fileId; POST /packages,
// /packages/:id/imports, /packages/:id/rows, /packages/:id/reconciliation.
// JSON responses are { data }; failures are { error, code }. Every write includes
// requestId/expectedVersion except register, whose immutable revision is its key.
function createBankingWorkspaceRouter(dependencies = {}) {
  const router = express.Router();
  let current;
  const service = () => dependencies.service || (current ||= require('../modules/banking-workspace-service').createBankingWorkspaceService());
  router.use(authenticate, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const action = (work, queryKeys = []) => async (req, res) => {
    try {
      if (Object.keys(req.query).some(key => !queryKeys.includes(key))) return res.status(400).json({ error: 'Unsupported banking query or company override.', code: 'BANKING_INVALID' });
      const data = await work(req, res);
      if (!res.headersSent) res.json({ data });
    } catch (error) {
      if(error.qboStage==='api'&&respondQboError(res,error))return;
      const domain=/^GENERAL_WRITE_[A-Z0-9_]{1,80}$/.test(error.code||'')||error.code==='QBO_WRITE_ADMISSION_DENIED',known=domain||/^(BANKING_|BUSINESS_ACCESS_)/.test(error.code||''),allowed=domain?[400,403,404,409]:[400,401,403,404,409],status=known&&allowed.includes(error.status)?error.status:500;
      const message=status===500?'Banking evidence could not be confirmed. Retain the exact request and retry.':String(error.message||'The original banking action is held.').replace(/[\u0000-\u001F\u007F]/g,' ').slice(0,1000);
      res.status(status).json({error:message,code:status===500?'BANKING_FAILED':String(error.code).slice(0,120)});
    }
  };
  const operator = () => dependencies.operator || require('../modules/banking-accountant-tools').createBankingRuntime({workspace:service()}).operator;
  router.get('/', action(async req => {
    const list=await service().list(req.user,req.query);
    const operatorLoop=await (dependencies.readLoopStatus || require('../modules/banking-operator-loop').readBankingLoopStatus)({packages:list.packages});
    let canResume=false;
    if(operatorLoop.resumeAvailable && operatorLoop.packageId){try{canResume=await operator().canResume(req.user,operatorLoop.packageId);}catch(error){if(!['BANKING_RESUME_FORBIDDEN','BUSINESS_ACCESS_DENIED'].includes(error.code))throw error;}}
    return {...list,operatorLoop:{...operatorLoop,canResume}};
  }, ['accountId','period']));
  router.get('/accounts/:accountId/statements',action(req=>service().monthlyStatements(req.user,req.params.accountId,{...(req.query.offset!==undefined?{offset:/^[0-9]+$/.test(req.query.offset)?Number(req.query.offset):NaN}:{}),...(req.query.limit!==undefined?{limit:/^[0-9]+$/.test(req.query.limit)?Number(req.query.limit):NaN}:{}),...(req.query.expectedHash!==undefined?{expectedHash:req.query.expectedHash}:{})}),['offset','limit','expectedHash']));
  router.post('/statements/issue',action(req=>service().issueMonthlyStatements(req.user,req.body)));
  router.get('/accounts/:accountId/statements/:statementId/files/:fileId',action(async(req,res)=>{const file=await service().downloadMonthlyStatement(req.user,req.params.accountId,req.params.statementId,req.params.fileId),extension=file.kind==='statement'?'.pdf':file.kind==='csv'?'.csv':'.json';res.set('Content-Type',file.kind==='statement'?'application/pdf':file.kind==='csv'?'text/csv; charset=utf-8':'application/json');res.set('X-Content-Type-Options','nosniff');res.set('Content-Disposition','attachment; filename="monthly-bank-statement-'+req.params.accountId+'-'+file.period+'-'+file.fileId.slice(0,12)+extension+'"');res.set('ETag','"'+file.sha256+'"');res.send(file.bytes);}));
  router.get('/accounts/:accountId/feeds',action(req=>service().currentFeeds(req.user,req.params.accountId,{...(req.query.mode!==undefined?{mode:req.query.mode}:{}),...(req.query.offset!==undefined?{offset:/^\d+$/.test(req.query.offset)?Number(req.query.offset):NaN}:{}),...(req.query.limit!==undefined?{limit:/^\d+$/.test(req.query.limit)?Number(req.query.limit):NaN}:{}),...(req.query.expectedHash!==undefined?{expectedHash:req.query.expectedHash}:{})}),['mode','offset','limit','expectedHash']));
  router.post('/feeds/publish',action(req=>service().publishCurrentFeed(req.user,req.body)));
  router.post('/feeds/cumulative',action(req=>service().publishCumulativeFeed(req.user,req.body)));
  router.get('/accounts/:accountId/feeds/:publicationId/files/:fileId',action(async(req,res)=>{const file=await service().downloadCurrentFeed(req.user,req.params.accountId,req.params.publicationId,req.params.fileId);res.set('Content-Type',file.kind==='csv'?'text/csv; charset=utf-8':'application/json');res.set('X-Content-Type-Options','nosniff');res.set('Content-Disposition','attachment; filename="current-bank-feed-'+req.params.accountId+'-'+file.fileId.slice(0,16)+(file.kind==='csv'?'.csv':'.json')+'"');res.set('ETag','"'+file.sha256+'"');res.send(file.bytes);}));
  router.get('/accounts/:accountId/origin-policy', action(req => service().originPolicy(req.user,req.params.accountId,{...(req.query.offset!==undefined?{offset:/^\d+$/.test(req.query.offset)?Number(req.query.offset):NaN}:{}),...(req.query.limit!==undefined?{limit:/^\d+$/.test(req.query.limit)?Number(req.query.limit):NaN}:{}),...(req.query.expectedHash!==undefined?{expectedHash:req.query.expectedHash}:{})}),['offset','limit','expectedHash']));
  router.post('/origins/policy', action(req => service().configureOriginPolicy(req.user,req.body)));
  router.post('/origins/process', action(req => service().processOriginDue(req.user,req.body)));
  router.post('/origins/advice', action(req => service().addOriginAdvice(req.user,req.body)));
  router.post('/origins/book', action(req => service().bookOriginEvent(req.user,req.body)));
  router.get('/accounts', action(req => service().accounts(req.user)));
  router.post('/instructions/retry', action(req => service().recoverInstructions(req.user,req.body)));
  router.post('/instructions/settle', action(req => service().settleInstructions(req.user,req.body)));
  router.get('/accounts/:accountId', action(req => service().accountDetail(req.user, req.params.accountId, req.query), ['period']));
  router.get('/accounts/:accountId/ledger-baseline', action(req => service().ledgerBaseline(req.user, req.params.accountId, req.query.throughPeriod), ['throughPeriod']));
  router.post('/accounts/:accountId/ledger', action(req => service().adoptLedger(req.user, req.params.accountId, req.body)));
  router.post('/operator/resume', action(async req => {
    const body=req.body;
    if(!body || Object.keys(body).some(k=>!['packageId','resolution'].includes(k)) || !/^[a-f0-9]{64}$/.test(body.packageId || ''))throw Object.assign(new Error('Exact packageId and resolution required'),{code:'BANKING_INVALID',status:400});
    const L=require('../modules/banking-operator-loop');
    const store=dependencies.pauseStore || L.filePauseStore(require('node:path').resolve(__dirname,'../../../artifacts/banking/operator-loop-paused.json'));
    return operator().resolvePause(req.user,{packageId:body.packageId,resolution:body.resolution,pause:await store.read(),clearPause:value=>store.clear(value)});
  }));
  router.post('/packages', action(req => service().register(req.user, req.body)));
  router.get('/packages/:id', action(async req => {
    const pkg=await service().detail(req.user,req.params.id);
    return {...pkg,operatorStatus:await operator().status(req.user,pkg.id)};
  }));
  router.get('/packages/:id/files/:fileId', action(async (req, res) => {
    const file = await service().download(req.user, req.params.id, req.params.fileId);
    const types = { csv: ['text/csv; charset=utf-8','csv'], statement: ['application/pdf','pdf'], manifest: ['application/json','json'] };
    const [type, extension] = types[file.kind];
    res.set('Content-Type', type); res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'attachment; filename="banking-' + file.fileId.replace(/[^A-Za-z0-9_-]/g, '_') + '.' + extension + '"');
    res.set('ETag', '"' + file.sha256 + '"'); res.send(file.bytes);
  }));
  router.post('/packages/:id/imports', action(req => service().recordImport(req.user, req.params.id, req.body)));
  router.post('/packages/:id/rows', action(req => service().recordRow(req.user, req.params.id, req.body)));
  router.post('/packages/:id/reconciliation', action(req => service().recordReconciliation(req.user, req.params.id, req.body)));
  return router;
}
module.exports = { createBankingWorkspaceRouter };
