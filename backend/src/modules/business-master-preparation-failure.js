'use strict';
// Only these server-owned messages may enter saved worker/status evidence.
const REASONS = Object.freeze({
  access: 'Company access changed. Restore current owner access before reading or continuing.',
  claim: 'The saved plan, storage, approval or company writer needs review before a worker can continue.',
  setup: 'Current accounts, tax or company preferences could not be verified. Refresh prerequisites.',
  country: 'Current Canadian company identity could not be verified. Refresh prerequisites.',
  reserve: 'The draft, protected dates or selected prerequisites changed. Review the saved plan and IDs.',
  dispatch: 'The create did not finish with a confirmed accepted identity. Review its retained request receipt.',
  readback: 'The accepted ID could not be read. Recover that exact ID before another create.',
  verify: 'The accepted record no longer matches the reviewed fields. Review or retain that ID unassigned.',
  finish: 'Saved progress or the company writer needs review before completion can be recorded.',
});
function masterFailure(stage, error) {
  const code = error?.code === 'BUSINESS_ACCESS_DENIED' ? 'access' : Object.hasOwn(REASONS, stage) ? stage : 'claim';
  return { code, message: REASONS[code] };
}
function assertMasterFailure(value) {
  if (value == null) return null;
  if (!Object.hasOwn(REASONS, value.code) || value.message !== REASONS[value.code] || Object.keys(value).sort().join(',') !== 'code,message') throw new TypeError('A bounded server-owned master failure is required');
  return { code: value.code, message: value.message };
}
module.exports = { masterFailure, assertMasterFailure };
