'use strict';
const { hash } = require('./business-calendar');
const SPECIALISTS = Object.freeze(['receivables', 'payables', 'inventory']);
const DEFAULT_SETTINGS = Object.freeze({ monitoring: false, autonomous: false, syncIntervalSeconds: 30, decisionIntervalMinutes: 60, instructions: '', specialists: [] });
const COMMANDS = Object.freeze(['enable-monitoring','enable-autonomy','pause','resume','stop-monitoring','run-now','sync-now','save-instructions','configure-specialists','configure','respond-decision']);
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_AGENT_UNAVAILABLE' }); }
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('Use the exact business-agent control without company or authority overrides.', 400); }
function validateControl(input) {
  if (!input || !COMMANDS.includes(input.command)) fail('Choose a supported business-agent control.', 400);
  const keys = ['command','expectedRevision','requestKey'];
  if (['enable-monitoring','enable-autonomy'].includes(input.command)) keys.push('confirmProduction');
  if (['save-instructions','configure-specialists','configure'].includes(input.command)) keys.push('settings');
  if (input.command === 'respond-decision') keys.push('decisionId','choice','note');
  exact(input, keys);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestKey)) fail('Refresh the current control version and retain its request identifier.', 400);
  if (keys.includes('confirmProduction') && typeof input.confirmProduction !== 'boolean') fail('Confirm the selected company explicitly.', 400);
  if (input.command === 'save-instructions') { exact(input.settings,['instructions']); if (typeof input.settings.instructions !== 'string' || input.settings.instructions.length > 6000) fail('Keep the owner instructions within 6000 characters.',400); }
  if (input.command === 'configure-specialists') { exact(input.settings,['specialists']); const roles=input.settings.specialists; if (!Array.isArray(roles) || roles.length > 3 || new Set(roles).size !== roles.length || roles.some(role=>!SPECIALISTS.includes(role))) fail('Select each supported specialist at most once.',400); }
  if (input.command === 'configure') { exact(input.settings,['syncIntervalSeconds','decisionIntervalMinutes']); if (!Number.isInteger(input.settings.syncIntervalSeconds) || input.settings.syncIntervalSeconds<15 || input.settings.syncIntervalSeconds>300 || !Number.isInteger(input.settings.decisionIntervalMinutes) || input.settings.decisionIntervalMinutes<5 || input.settings.decisionIntervalMinutes>1440) fail('Use a monitoring interval of 15–300 seconds and a decision interval of 5–1440 minutes.',400); }
  if (input.command === 'respond-decision' && (!ID.test(input.decisionId || '') || !['accept','decline'].includes(input.choice) || typeof input.note !== 'string' || input.note.trim().length < 1 || input.note.length > 3000)) fail('Choose a saved decision and record the owner response.',400);
  return input;
}
function reduceControl(row, input, business, clock, ownerId) {
  const settings = { ...DEFAULT_SETTINGS, ...(row?.settings || {}) }, changes = {}, now = new Date(clock);
  if (['enable-monitoring','enable-autonomy'].includes(input.command) && business.scope.environment === 'production' && input.confirmProduction !== true) fail('Explicit consent for this Production company is required.',400);
  switch(input.command) {
    case 'enable-monitoring': settings.monitoring=true; changes.nextSyncAt=now; changes.status=settings.autonomous?'ready':'monitoring'; break;
    case 'enable-autonomy':
      if (!settings.monitoring) fail('Enable company monitoring before autonomous operation.');
      if (!HASH.test(business.authorityHash || '')) fail('Publish the business policy before granting autonomous accounting authority.');
      settings.autonomous=true; changes.grant={id:hash({agentId:row._id,ownerId,authorityHash:business.authorityHash,requestKey:input.requestKey}),authorityHash:business.authorityHash,activityPolicyHash:require('./business-activity-batch').POLICY_HASH,ownerId,issuedAt:now.toISOString()}; changes.nextDecisionAt=now; changes.status='ready'; break;
    case 'resume': if (!settings.monitoring || !row?.grant || row.grant.authorityHash!==business.authorityHash) fail('Enable monitoring and renew the current published-business authority before resuming.'); settings.autonomous=true; changes.nextDecisionAt=now; changes.status='ready'; break;
    case 'pause': settings.autonomous=false; changes.status=settings.monitoring?'paused':'stopped'; break;
    case 'stop-monitoring': settings.monitoring=false; settings.autonomous=false; changes.status='stopped'; break;
    case 'sync-now': if (!settings.monitoring) fail('Enable monitoring before requesting a sync.'); changes.nextSyncAt=now; break;
    case 'run-now': if (!settings.autonomous || !settings.monitoring) fail('Enable autonomous operation before requesting a business review.'); changes.nextDecisionAt=now; break;
    case 'save-instructions': settings.instructions=input.settings.instructions.trim(); if(settings.autonomous) changes.nextDecisionAt=now; break;
    case 'configure-specialists': settings.specialists=[...input.settings.specialists]; break;
    case 'configure': Object.assign(settings,input.settings); changes.nextSyncAt=now; if(settings.autonomous)changes.nextDecisionAt=now; break;
    case 'respond-decision': if(settings.autonomous)changes.nextDecisionAt=now; break;
    default: fail('Unsupported business control.',400);
  }
  return { ...changes, settings, nextWakeAt: now, lastError: null };
}
function businessBlockers({ calendar, writer, job, run, policy }) {
  const blockers=[];
  const add=(code,title,detail)=>blockers.push({code,title,detail,href:'/company/manage'});
  if (!calendar?.authorityHash) add('not-published','Publish the business','Choose and publish the business policy before autonomous accounting activity.');
  if (calendar?.stopRequested) add('calendar-stopped','Business activity is stopped','Review the saved Stop request before resuming accounting activity.');
  if (calendar?.pendingCommit) add('completion-pending','A saved period needs completion recovery','Retain the current operation and settle its saved completion evidence.');
  if (writer?.unresolved) add('uncertain-write','A QuickBooks request needs recovery','A request may already have been saved. Keep its exact receipt; it must not be sent again.');
  if (writer?.populationDelegation) add('population-owned','Saved population work owns the company','Review and settle the original population job before preparing another business operation. Existing records will be retained.');
  if (run && !['verified','retired'].includes(run.status)) add('current-operation','Continue the retained business operation',run.lastError || 'The original operation must be inspected and continued before another period is prepared.');
  if (job && !calendar?.verifiedThrough) add('history-uncommitted','Existing business history needs verification','Records have already been populated. Verify their original identities and accounting evidence; do not rebuild from the opening date.');
  if (calendar?.authorityHash && policy?.state!=='active') add('coordination-paused','Company accounting coordination is paused','Finish the existing company write-coordination workflow before further accounting activity.');
  return blockers;
}
module.exports={SPECIALISTS,DEFAULT_SETTINGS,COMMANDS,ID,HASH,fail,exact,validateControl,reduceControl,businessBlockers};
