'use strict';
const express=require('express');
const {authenticate}=require('../middleware/auth');
const {rejectContextOverrides}=require('./rebuild');
const {respondQboError}=require('../modules/qbo-error');
function createBusinessAgentRouter({service=()=>require('../modules/business-agent-service').getBusinessAgentService()}={}){
  const router=express.Router();router.use(authenticate,rejectContextOverrides,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use((req,res,next)=>Object.keys(req.query).length?res.status(400).json({error:'Business-agent controls do not accept query overrides.'}):next());
  const action=work=>async(req,res)=>{try{res.json({data:await work(req)});}catch(error){if(error.qboStage==='api'&&respondQboError(res,error))return;const known=/^BUSINESS_/.test(error.code||''),status=known&&[400,403,404,409].includes(error.status)?error.status:500;res.status(status).json({error:status===500?'Business monitoring could not be read. Saved controls and activity are retained.':error.message,code:known?error.code:'BUSINESS_AGENT_UNAVAILABLE'});}};
  router.get('/',action(req=>service().status(req.user)));
  router.get('/live',action(req=>service().live(req.user)));
  // Review session transcripts. The cursor travels in the path (polling) or Last-Event-ID (stream), never a query.
  router.get('/transcripts',action(req=>service().transcripts(req.user)));
  router.get('/transcripts/stream',async(req,res)=>{
    try{await service().transcriptStream(req.user,{cursor:require('../modules/business-agent-transcript').parseCursor(req.get('Last-Event-ID'))},req,res);}
    catch(error){if(res.headersSent){if(!res.writableEnded)res.end();return;}const known=/^BUSINESS_/.test(error.code||''),status=[400,403,404,409,429].includes(error.status)?error.status:500;res.status(status).json({error:status===500?'The live review stream is unavailable. Saved activity is retained.':error.message,code:known?error.code:'BUSINESS_AGENT_UNAVAILABLE'});}
  });
  router.get('/transcripts/:attemptId/after/:seq',action(req=>service().transcript(req.user,req.params.attemptId,/^\d{1,6}$/.test(req.params.seq)?Number(req.params.seq):-1)));
  router.get('/tools',action(()=>require('../modules/business-agent-catalog').agentToolCatalog()));
  router.post('/control',action(req=>service().control(req.user,req.body)));
  return router;
}
module.exports={createBusinessAgentRouter};
