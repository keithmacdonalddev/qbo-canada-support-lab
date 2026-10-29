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
  router.get('/tools',action(()=>require('../modules/business-agent-catalog').agentToolCatalog()));
  router.post('/control',action(req=>service().control(req.user,req.body)));
  return router;
}
module.exports={createBusinessAgentRouter};
