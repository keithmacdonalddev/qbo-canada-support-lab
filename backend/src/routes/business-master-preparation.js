'use strict';
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectContextOverrides } = require('./rebuild');
const { respondQboError } = require('../modules/qbo-error');
function createMasterPreparationRouter(dependencies = {}) {
  const router = express.Router(); let current;
  const service = dependencies.service || (() => current ||= require('../modules/business-master-service').createMasterService());
  router.use(authenticate, rejectContextOverrides, (req,res,next) => {
    res.set('Cache-Control','no-store');
    if (Object.keys(req.query).length) return res.status(400).json({error:'Master preparation does not accept company or query overrides.'});
    next();
  });
  const action = (work, background = false) => async (req,res) => {
    try { const data = await work(req); res.status(background && data.workerClaimed ? 202 : 200).json({data}); }
    catch (error) {
      const local = /^BUSINESS_/.test(error.code || '') || error.businessPlanError || error.setupError || error.qboStage === 'write_admission' || error.qboStage === 'write_receipt';
      if (!local && respondQboError(res,error)) return;
      const status = local && [400,403,404,409,503].includes(error.status) ? error.status : error.setupError ? 409 : 500;
      res.status(status).json({error:status===500?'Master preparation could not finish. Check saved progress before retrying.':error.message,code:/^BUSINESS_/.test(error.code || '')?error.code:'BUSINESS_MASTER_UNAVAILABLE'});
    }
  };
  const empty = req => { if (!req.body || Object.keys(req.body).length) throw Object.assign(new Error('This action takes no company or state overrides.'),{status:400,code:'BUSINESS_MASTER_UNAVAILABLE'}); };
  router.get('/',action(req=>service().status(req.user)));
  router.post('/history',action(req=>service().history(req.user,req.body)));
  router.post('/storage/preview',action(req=>{empty(req);return service().storagePreview(req.user);}));
  router.post('/storage/apply',action(req=>service().storageApply(req.user,req.body)));
  router.post('/prepare',action(req=>service().prepare(req.user,req.body)));
  router.get('/:id',action(req=>service().inspect(req.user,req.params.id)));
  for (const name of ['approve','stop','retry','retain','apply']) router.post('/:id/'+name,action(req=>service()[name](req.user,req.params.id,req.body)));
  router.post('/:id/execute',action(req=>service().execute(req.user,req.params.id,req.body),true));
  router.post('/:id/recover',action(req=>service().recover(req.user,req.params.id,req.body),true));
  router.post('/:id/apply-review',action(req=>service().applyReview(req.user,req.params.id,req.body)));
  router.post('/:id/unknown/review',action(req=>service().attributionReview(req.user,req.params.id,req.body)));
  router.post('/:id/unknown/attribute',action(req=>service().attribute(req.user,req.params.id,req.body)));
  return router;
}
module.exports={createMasterPreparationRouter};
