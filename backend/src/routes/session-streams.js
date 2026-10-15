'use strict';
const express=require('express');
const {authenticate}=require('../middleware/auth');
function createSessionStreamRouter({streams=require('../modules/ai-session-streams').sessionStreams()}={}){
 const router=express.Router();router.use(authenticate);
 router.post('/stream-ticket',async(req,res)=>{
  try{return res.json({success:true,data:await streams.issue({user:req.user,account:req.currentAccount,sessionId:req.body?.sessionId})});}
  catch(error){return res.status(error.status||503).json({success:false,error:error.status?error.message:'Session stream authority could not be checked.'});}
 });
 router.get('/stream/:sessionId',async(req,res)=>{
  try{await streams.open({user:req.user,account:req.currentAccount,sessionId:req.params.sessionId,ticket:req.query.ticket},req,res);}
  catch(error){if(!res.headersSent)return res.status(error.status||503).json({success:false,error:error.status?error.message:'Session stream authority could not be checked.'});res.end();}
 });
 return router;
}
module.exports={createSessionStreamRouter};
