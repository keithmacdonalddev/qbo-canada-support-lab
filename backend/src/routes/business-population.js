'use strict';
const express=require('express');
const {authenticate}=require('../middleware/auth');
const {rejectContextOverrides}=require('./rebuild');
const {respondQboError}=require('../modules/qbo-error');
function createBusinessPopulationRouter({service=()=>require('../modules/business-population-service').getBusinessPopulationService()}={}){
  const router=express.Router();router.use(authenticate,rejectContextOverrides);
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');if(Object.keys(req.query).length)return res.status(400).json({error:'Population actions do not accept query overrides.'});next();});
  const action=work=>async(req,res)=>{try{await work(req,res);}catch(error){if(error.qboStage==='api'&&respondQboError(res,error))return;const status=[400,403,404,409].includes(error.status)?error.status:500;res.status(status).json({error:status===500?'Bulk business activity is unavailable. Saved records and progress are retained.':error.message});}};
  router.get('/',action(async(req,res)=>res.json({data:await service().status(req.user)})));
  router.post('/prepare',action(async(req,res)=>res.json({data:await service().prepare(req.user,req.body)})));
  router.post('/:id/start',action(async(req,res)=>res.status(202).json({data:await service().start(req.user,req.params.id,req.body)})));
  router.post('/:id/stop',action(async(req,res)=>{if(req.body&&Object.keys(req.body).length)return res.status(400).json({error:'Stop does not accept state overrides.'});res.json({data:await service().stop(req.user,req.params.id)});}));
  return router;
}
module.exports={createBusinessPopulationRouter};
