'use strict';
const crypto = require('node:crypto');
const { accountEligible, accountVersion } = require('./account-policy');
const ID = /^[a-f0-9]{24}$/i, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const fail = (message = 'Agent app access is unavailable.', status = 401) => { throw Object.assign(new Error(message), { status }); };
const digest = secret => crypto.createHash('sha256').update(secret).digest('hex');
const connectionVersion = user => user.connectionSwitchVersion ?? 0;
function validBinding(value) {
  return Boolean(value && !Array.isArray(value) && Object.keys(value).length===4 && typeof value.credentialId==='string' && UUID.test(value.credentialId) && typeof value.realmId==='string' && /^[0-9]{5,30}$/.test(value.realmId)
    && ['production','sandbox'].includes(value.environment) && typeof value.connectionId==='string' && ID.test(value.connectionId));
}
function binding(user) {
  const value = { credentialId:user.agentCredentialId, realmId:user.agentCredentialRealmId,
    environment:user.agentCredentialEnvironment, connectionId:user.agentCredentialConnectionId };
  if (!validBinding(value) || !accountEligible(user) || accountVersion(user) !== user.agentCredentialAuthVersion) fail();
  return value;
}
function matches(user, credential) {
  try {
    const value = binding(user);
    if (credential.credentialId !== value.credentialId || !SECRET.test(credential.secret || '') || !/^[a-f0-9]{64}$/.test(user.agentCredentialHash || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(digest(credential.secret),'hex'),Buffer.from(user.agentCredentialHash,'hex'));
  } catch { return false; }
}
function newCredential() { return { credentialId:crypto.randomUUID(), secret:crypto.randomBytes(32).toString('base64url') }; }
async function findCurrentConnection(Connections, accountId) {
  // Match the app's connection-status preference, including retained failures.
  // OAuth health blocks QBO work, not access to the owner's app/settings.
  for (const status of ['active','expired','error','revoked']) {
    const value = await Connections.findOne({userId:accountId,status}).sort({updatedAt:-1}).select('_id userId realmId status').maxTimeMS(3000).lean();
    if (value) return value;
  }
  return null;
}
function createAgentAccess({ Users, Connections, Audits, transaction, environment, issueToken = require('./auth-token').issueToken }) {
  async function activeConnection(accountId, session) {
    let query = Connections.findOne({userId:accountId,status:'active'}).sort({updatedAt:-1}).select('_id userId realmId status');
    if (session) query = query.session(session);
    return query.lean();
  }
  async function login(input) {
    if (!input || !ID.test(input.accountId || '') || !UUID.test(input.credentialId || '') || !SECRET.test(input.secret || '')
      || typeof input.actor !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.actor)) fail();
    const user = await Users.findById(input.accountId).select('+agentCredentialHash');
    if (!user || !matches(user,input)) fail();
    const agent = binding(user), connection = await findCurrentConnection(Connections,user._id);
    if (!connection || String(connection._id)!==agent.connectionId || connection.realmId !== agent.realmId || environment !== agent.environment) fail();
    await Audits.create({userId:user._id,realmId:agent.realmId,action:'Agent app sign-in',actionType:'auth',
      inputParams:{credentialId:agent.credentialId,actor:input.actor},outcome:'success'});
    return { token:issueToken(user,{agent}), user:user.toJSON() };
  }
  async function enroll({accountId,realmId,credential}) {
    if (!ID.test(accountId || '') || !/^[0-9]{5,30}$/.test(realmId || '') || !UUID.test(credential?.credentialId || '') || !SECRET.test(credential?.secret || '')) fail('Invalid agent enrollment target.',400);
    return transaction(async session => {
      const user = await Users.findById(accountId).session(session).lean();
      if (!accountEligible(user)) fail('The existing account must already have private app access.',409);
      const connection = await activeConnection(accountId,session);
      if (!connection || connection.realmId !== realmId) fail('The existing active company does not match enrollment.',409);
      if (user.agentCredentialId) fail('An agent credential already exists. Reuse it or explicitly revoke it first.',409);
      const av = accountVersion(user), cv = connectionVersion(user);
      const fields = {agentCredentialId:credential.credentialId,agentCredentialHash:digest(credential.secret),
        agentCredentialRealmId:realmId,agentCredentialEnvironment:environment,agentCredentialAuthVersion:av,
        agentCredentialConnectionId:String(connection._id),agentCredentialCreatedAt:new Date()};
      const result = await Users.updateOne({_id:accountId,role:user.role,
        $and:[{$or:[{authVersion:av},...(av===0?[{authVersion:{$exists:false}}]:[])]},
          {$or:[{connectionSwitchVersion:cv},...(cv===0?[{connectionSwitchVersion:{$exists:false}}]:[])]},
          {$or:[{agentCredentialId:{$exists:false}},{agentCredentialId:null}]}]},{$set:fields},{session});
      if (result.matchedCount !== 1) fail('The account changed during enrollment. Nothing was replaced.',409);
      // Force a write conflict with a concurrent connection switch/disconnect.
      const fenced = await Connections.updateOne({_id:connection._id,userId:accountId,realmId,status:'active'},
        {$inc:{agentCredentialEnrollmentVersion:1}},{session,strict:false});
      if (fenced.matchedCount !== 1) fail('The company changed during enrollment.',409);
      await Audits.create([{userId:accountId,realmId,action:'Agent app credential enrolled',actionType:'auth',
        inputParams:{credentialId:credential.credentialId},outcome:'success'}],{session});
      return {accountId,realmId,credentialId:credential.credentialId,authVersion:av,connectionId:String(connection._id),environment};
    });
  }
  async function revoke({accountId,credentialId}) {
    if (!ID.test(accountId || '') || !UUID.test(credentialId || '')) fail('Invalid agent revocation target.',400);
    return transaction(async session => {
      const user = await Users.findById(accountId).session(session).lean();
      if (!user || user.agentCredentialId !== credentialId) fail('Agent credential no longer matches.',409);
      const result = await Users.updateOne({_id:accountId,agentCredentialId:credentialId},{$unset:{
        agentCredentialId:1,agentCredentialHash:1,agentCredentialRealmId:1,agentCredentialEnvironment:1,
        agentCredentialAuthVersion:1,agentCredentialConnectionId:1,agentCredentialConnectionVersion:1,agentCredentialCreatedAt:1}},{session});
      if (result.matchedCount !== 1) fail('Agent credential changed.',409);
      await Audits.create([{userId:accountId,realmId:user.agentCredentialRealmId,action:'Agent app credential revoked',
        actionType:'auth',inputParams:{credentialId},outcome:'success'}],{session});
      return {revoked:true,accountId};
    });
  }
  return {login,enroll,revoke};
}
function defaultAgentAccess() {
  const mongoose = require('mongoose');
  return createAgentAccess({Users:require('../models/User'),Connections:require('../models/Connection'),Audits:require('../models/AuditLog'),
    transaction:require('./business-transaction').createBusinessTransaction(mongoose.connection),environment:require('../config').qbo.environment});
}
module.exports = {ID,UUID,SECRET,digest,newCredential,validBinding,binding,matches,connectionVersion,findCurrentConnection,createAgentAccess,defaultAgentAccess};
