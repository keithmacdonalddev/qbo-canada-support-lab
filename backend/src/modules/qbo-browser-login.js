'use strict';
// Deterministic authentication only. Never accepts arbitrary vault targets, URLs or selectors.
const REALM='9130357222392856', COMPANY='My Business', LOGIN='https://accounts.intuit.com', QBO='https://qbo.intuit.com';
const TARGET='TestDataLab/QBO/production/2856';
const ACTORS=new Set(['app','accountant','claude-code','codex-cli']);
const MESSAGES={QBO_CREDENTIAL_MISSING:'The saved dedicated Intuit login is unavailable.',QBO_SIGNIN_REQUIRED:'The dedicated Intuit login needs attention.',QBO_VERIFICATION_REQUIRED:'Intuit needs your verification in the automation browser.',QBO_IDENTITY_UNVERIFIED:'The signed-in Intuit user could not be confirmed as the dedicated account.',QBO_COMPANY_MISMATCH:'The automation browser did not prove the approved My Business company ID.',QBO_BROWSER_UNAVAILABLE:'The dedicated automation browser could not be reached.',QBO_SESSION_BUSY:'Another operator owns the automation browser.',QBO_SESSION_UNCERTAIN:'Browser process cleanup is unverified; the shared lock was retained.'};
const STAGE_MESSAGES=Object.freeze({'opening-browser':'Opening the dedicated sign-in browser.','checking-sign-in':'Checking the dedicated sign-in.','using-saved-password':'Using the saved password for the account shown by Intuit.','entering-username':'Entering the dedicated sign-in name.','submitting-password':'Submitting the saved password.','waiting-for-sign-in':'Waiting for Intuit to finish sign-in.','opening-company':'Opening the approved company for verification.','verifying-identity':'Verifying the dedicated signed-in identity.','verifying-company':'Verifying the approved company.','ready':'Dedicated Intuit user and My Business company verified.','blocked':'The dedicated sign-in needs attention.'});
function failure(code){return Object.assign(new Error(MESSAGES[code]||MESSAGES.QBO_SIGNIN_REQUIRED),{code:Object.hasOwn(MESSAGES,code)?code:'QBO_SIGNIN_REQUIRED',status:409});}
function scopeOk(scope){return scope?.realmId===REALM && scope?.environment==='production';}
function validActor(actor){if(!ACTORS.has(actor))throw failure('QBO_SIGNIN_REQUIRED');return actor;}
function normalizeUser(value){return typeof value==='string'?value.trim().toLowerCase():'';}
function loginOrigin(url){try{const u=new URL(url);return u.origin===LOGIN&&!u.username&&!u.password;}catch{return false;}}
function qboOrigin(url){try{const u=new URL(url);return u.origin===QBO&&!u.username&&!u.password&&u.pathname.startsWith('/app/');}catch{return false;}}
async function ensureLogin({browser,readCredential,maxSteps=12,onStage=async()=>{}}){
 let credential;
 try{credential=await readCredential();}catch(error){throw failure(error?.code==='QBO_SESSION_UNCERTAIN'?'QBO_SESSION_UNCERTAIN':'QBO_CREDENTIAL_MISSING');}
 if(!normalizeUser(credential?.username)||typeof credential?.password!=='string'||!credential.password.length)throw failure('QBO_CREDENTIAL_MISSING');
 let passwordSent=false,usernameSent=false,pickerUsed=false,homeRequested=false,lastStage=null;
 const stage=async value=>{if(value!==lastStage){await onStage(value);lastStage=value;}};
 try{
  await stage('opening-browser');await browser.open();await stage('checking-sign-in');
  for(let n=0;n<maxSteps;n++){
   const state=await browser.inspect();
   const picker=state.phase==='password-choice'&&state.passwordChoice===true&&!passwordSent&&!pickerUsed;
   if(state.captcha||state.challenge&&!picker)throw failure('QBO_VERIFICATION_REQUIRED');
   if(state.rejected)throw failure('QBO_SIGNIN_REQUIRED');
   if(qboOrigin(state.url)){
    // This is a live account-manager UI observation, never a saved enrollment flag.
    await stage('verifying-identity');if(!await browser.verifyIdentity(credential.username))throw failure('QBO_IDENTITY_UNVERIFIED');
    await stage('verifying-company');const proof=await browser.verifyCompany();
    if(proof?.realmId!==REALM||proof?.name!==COMPANY)throw failure('QBO_COMPANY_MISMATCH');
    return {status:'ready',companyVerified:true,identityVerified:true,realmId:REALM,environment:'production',authenticated:passwordSent};
   }
   // After the password is accepted Intuit can redirect through other pages on the
   // way to QuickBooks. Wait (bounded by maxSteps); nothing is entered off the login origin.
   if(!loginOrigin(state.url)){if(passwordSent){await stage('waiting-for-sign-in');await browser.settle();continue;}throw failure('QBO_SIGNIN_REQUIRED');}
   if(new URL(state.url).pathname==='/app/account-manager/overview'&&!homeRequested){
    homeRequested=true;await stage('opening-company');await browser.navigateHome();continue;
   }
   if(picker){
    pickerUsed=true;await stage('using-saved-password');
    const bound=await browser.enterPasswordFromPicker({username:credential.username,password:credential.password});
    if(bound?.targetVerifiedOnPicker!==true||bound.passwordSelected!==true||bound.passwordSubmitted!==true)throw failure('QBO_IDENTITY_UNVERIFIED');
    passwordSent=true;await stage('waiting-for-sign-in');continue;
   }
   if(state.phase==='remembered'){await browser.differentAccount();continue;}
   if(state.phase==='username'&&!usernameSent){await stage('entering-username');await browser.enterUsername(credential.username);usernameSent=true;continue;}
   if(state.phase==='password'&&!passwordSent){
    if(new URL(state.url).pathname==='/app/account-manager')throw failure('QBO_IDENTITY_UNVERIFIED');
    if(!await browser.usernameMatches(credential.username))throw failure('QBO_IDENTITY_UNVERIFIED');
    // Origin/form/visibility checks and entry+submit run in ONE browser operation.
    await stage('submitting-password');await browser.enterPassword(credential.password);passwordSent=true;await stage('waiting-for-sign-in');continue;
   }
   if(state.phase==='password'&&passwordSent){await browser.settle();continue;}
   if(state.phase==='username'&&usernameSent){await browser.settle();continue;}
   if(state.phase==='transition'){await stage('waiting-for-sign-in');await browser.settle();continue;}
   throw failure('QBO_SIGNIN_REQUIRED');
  }
  throw failure('QBO_SIGNIN_REQUIRED');
 }catch(error){if(Object.hasOwn(MESSAGES,error?.code))throw failure(error.code);throw failure('QBO_BROWSER_UNAVAILABLE');}
 finally{if(credential){credential.password='';credential.username='';}credential=null;}
}
module.exports={REALM,COMPANY,LOGIN,QBO,TARGET,ACTORS,MESSAGES,STAGE_MESSAGES,failure,scopeOk,validActor,normalizeUser,loginOrigin,qboOrigin,ensureLogin};
