'use strict';
const { createHash } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { RESERVED_EMAIL, accountVersion, isReservedAccount, publicTesterAttempt } = require('./account-policy');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status=409) => { throw Object.assign(new Error(message), {status}); };
function assertPrivatePassword(value) {
  if (typeof value !== 'string' || [...value].length < 15 || Buffer.byteLength(value,'utf8') > 72 || value.includes('\0')) fail('Use a private password with at least 15 characters and at most 72 UTF-8 bytes.',400);
  if (publicTesterAttempt(RESERVED_EMAIL,value)) fail('The historical public password is refused.',400);
}
function createAccountRecovery({Users,Audits,transaction,targetFingerprint,hashPassword=value=>bcrypt.hash(value,10)}) {
  if (!/^[a-f0-9]{64}$/.test(targetFingerprint||'')) throw new TypeError('Credential recovery requires an exact local storage target fingerprint.');
  const read = (id,session) => Users.findById(id).select('_id email role password authVersion accessPolicyVersion automationAccessPolicyVersion connectionSwitchVersion').session(session).maxTimeMS(3000).lean();
  function review(account) {
    if (!account || !isReservedAccount(account) || !['agent','supervisor'].includes(account.role) || accountVersion(account) === null) fail('The reserved existing account was not found or is unavailable. Recovery does not create or promote accounts.');
    const state={targetFingerprint,id:String(account._id),email:account.email,role:account.role,authVersion:accountVersion(account),accessPolicyVersion:account.accessPolicyVersion??0,automationAccessPolicyVersion:account.automationAccessPolicyVersion??0};
    return {...state,reviewHash:hash({version:1,...state,passwordHash:account.password,connectionSwitchVersion:account.connectionSwitchVersion??0}),automationAfterRecovery:'paused',retainedWork:'Existing ownership, memberships, records, plans and jobs are preserved. Inspect retained work in Settings before enabling automation.'};
  }
  async function preview(id) {return review(await read(id));}
  async function apply({id,reviewHash,password}) {
    assertPrivatePassword(password);
    if (!/^[a-f0-9]{64}$/.test(reviewHash||'')) fail('Review the exact existing account before recovery.');
    const encoded=await hashPassword(password);
    return transaction(async session=>{
      const account=await read(id,session),current=review(account);
      if(current.reviewHash!==reviewHash)fail('The account changed. Read a fresh recovery preview.');
      const nextVersion=current.authVersion+1;
      if(!Number.isSafeInteger(nextVersion)||nextVersion>=Number.MAX_SAFE_INTEGER)fail('The account version cannot be advanced.');
      const filter={_id:account._id,email:account.email,role:account.role,password:account.password,authVersion:account.authVersion===undefined?{$exists:false}:account.authVersion};
      const changed=await Users.updateOne(filter,{$set:{password:encoded,authVersion:nextVersion,accessPolicyVersion:1,automationAccessPolicyVersion:0},$unset:{automationReviewHash:1},$inc:{connectionSwitchVersion:1}},{session});
      if(changed.matchedCount!==1)fail('The account changed during recovery.');
      await Audits.create([{userId:account._id,realmId:'account:'+String(account._id),action:'Private account credentials recovered; automation paused',actionType:'auth',outcome:'success',beforeState:{authVersion:current.authVersion},afterState:{authVersion:nextVersion,accessPolicyVersion:1,automationAccessPolicyVersion:0,reviewHash}}],{session});
      return {id:String(account._id),email:account.email,role:account.role,authVersion:nextVersion,automationAfterRecovery:'paused',sessionsRevoked:true};
    });
  }
  return {preview,apply};
}
module.exports={createAccountRecovery,assertPrivatePassword};
