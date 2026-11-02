'use strict';
const { verifyToken } = require('../modules/auth-token');
const mongoose = require('mongoose');
const config = require('../config');
const { runAsActor } = require('../modules/actor-context');
const { accountVersion, accountEligible, isReservedAccount } = require('../modules/account-policy');
const ID = /^[a-f0-9]{24}$/i;
// These public endpoints retain their own nonce/capability protocols. Every
// other /api path is guarded before a route can rewrite the workspace owner.
function publicEndpoint(req) {
  const path = req.path.replace(/\/$/, '') || '/';
  return (req.method === 'GET' && ['/health','/auth/dev-access','/qbo/callback'].includes(path))
    || (req.method === 'POST' && ['/auth/login','/auth/agent-login','/auth/register','/screen-reader/capability'].includes(path))
    || (path === '/ai-tools/mcp' && ['GET','POST','DELETE'].includes(req.method));
}
async function loadCurrentAccount(id) {
  if (mongoose.connection.readyState !== 1) throw new Error('Account storage unavailable');
  return require('../models/User').findById(id).select('_id email role authVersion accessPolicyVersion agentCredentialId agentCredentialRealmId agentCredentialEnvironment agentCredentialAuthVersion agentCredentialConnectionId').maxTimeMS(3000).lean();
}
async function loadAgentConnection(accountId) {
  return require('../modules/agent-app-access').findCurrentConnection(require('../models/Connection'),accountId);
}
function createCurrentAccountGuard({ loadAccount = loadCurrentAccount, loadConnection = loadAgentConnection, secret = () => config.jwtSecret } = {}) {
  return async function currentAccount(req,res,next) {
    if (publicEndpoint(req)) return next();
    const header = req.get('authorization');
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 8192) return res.status(401).json({error:'Authentication required'});
    let decoded;
    try { decoded = verifyToken(header.slice(7),secret()); }
    catch { return res.status(401).json({error:'Invalid or expired token'}); }
    if (!decoded || !ID.test(String(decoded.id || '')) || (decoded.av !== undefined && (!Number.isSafeInteger(decoded.av) || decoded.av < 0))) return res.status(401).json({error:'Invalid or expired token'});
    let account;
    try { account = await loadAccount(String(decoded.id)); }
    catch { return res.status(503).json({error:'Current account access could not be checked. Try again when storage is available.',code:'ACCOUNT_ACCESS_UNAVAILABLE'}); }
    if (!account || String(account._id) !== String(decoded.id) || !accountEligible(account) || accountVersion(account) !== (decoded.av ?? 0) || (isReservedAccount(account) && decoded.av === undefined)) return res.status(401).json({error:'This session is no longer authorized. Sign in with private account credentials.',code:'ACCOUNT_SESSION_REVOKED'});
    if (decoded.agent) {
      try {
        const expected = require('../modules/agent-app-access').binding(account);
        if (Object.keys(expected).some(key => expected[key] !== decoded.agent[key]) || expected.environment !== config.qbo.environment) return res.status(401).json({error:'Agent app access was revoked or its company changed',code:'AGENT_SESSION_REVOKED'});
        const connection = await loadConnection(String(account._id));
        if (connection?.realmId !== expected.realmId || String(connection?._id)!==expected.connectionId) return res.status(401).json({error:'Agent company is no longer current',code:'AGENT_SESSION_REVOKED'});
      } catch (error) {
        return res.status(error.status===401?401:503).json({error:error.status===401?'Agent app access was revoked':'Agent company access could not be checked',code:error.status===401?'AGENT_SESSION_REVOKED':'ACCOUNT_ACCESS_UNAVAILABLE'});
      }
    }
    const current = Object.freeze({id:String(account._id),email:account.email,role:account.role,authVersion:accountVersion(account),accessPolicyVersion:account.accessPolicyVersion ?? 0,sessionExpiresAt:decoded.exp*1000});
    req.currentAccount = current;
    req.readCurrentAccount = loadAccount;
    req.user = {...current};
    return runAsActor(current.id,next);
  };
}
module.exports = {createCurrentAccountGuard,loadCurrentAccount,publicEndpoint};
