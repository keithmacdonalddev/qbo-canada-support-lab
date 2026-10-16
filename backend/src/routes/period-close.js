'use strict';
const express=require('express');
const {authenticate}=require('../middleware/auth');
const {rejectContextOverrides}=require('./rebuild');
const {respondQboError}=require('../modules/qbo-error');
const C=require('../modules/period-close-contract');
function createPeriodCloseRouter(dependencies={}){
  const router=express.Router();let current;
  const service=dependencies.service || (()=>current ||= require('../modules/period-close-service').createPeriodCloseService());
  router.use(authenticate,rejectContextOverrides,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const noQuery=req=>{if(Object.keys(req.query).length)C.fail('This period action accepts no query or company overrides.',400);};
  const exactBody=(req,keys)=>{if(!C.exact(req.body,keys))C.fail('Use the exact accounting-period action.',400);};
  const action=work=>async(req,res)=>{
    const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort();};
    req.on('aborted',abort);res.on('close',abort);
    try{res.json({data:await work(req,controller.signal)});}
    catch(error){
      if(res.destroyed)return;
      const known=/^(?:PERIOD_CLOSE_|REPORT_EVIDENCE_|BUSINESS_|QBO_WRITE_)/.test(error.code || '') || error.setupError;
      if(!known && respondQboError(res,error,{readAttempts:error.periodReadAttempts}))return;
      const status=known && [400,403,404,409].includes(error.status)?error.status:500;
      res.status(status).json({error:status===500?'Accounting-period evidence could not be confirmed. Retain and retry the exact pending decision.':error.message,...(known?{code:error.code}:{}),...(Number.isSafeInteger(error.periodReadAttempts)?{qboReadAttempts:error.periodReadAttempts}:{})});
    }finally{req.off('aborted',abort);res.off('close',abort);}
  };
  router.get('/',action(req=>{if(Object.keys(req.query).some(key=>key!=='after'))C.fail('Period history accepts only its exact cursor.',400);return service().status(req.user,req.query);}));
  router.post('/accounts',action((req,signal)=>{noQuery(req);exactBody(req,[]);return service().accounts(req.user,{signal});}));
  router.post('/sources',action(req=>{noQuery(req);exactBody(req,['period']);return service().sources(req.user,req.body.period);}));
  router.post('/review',action((req,signal)=>{noQuery(req);exactBody(req,['request']);return service().review(req.user,req.body.request,{signal});}));
  router.post('/apply',action((req,signal)=>{noQuery(req);return service().apply(req.user,req.body,{signal});}));
  router.post('/cancel',action(req=>{noQuery(req);return service().cancel(req.user,req.body);}));
  router.get('/:id',action(req=>{noQuery(req);return service().detail(req.user,req.params.id);}));
  return router;
}
module.exports={createPeriodCloseRouter};
