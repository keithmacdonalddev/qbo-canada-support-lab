'use strict';
const { describeBusinessActivity } = require('./business-activity-details');
const { date, planBusinessCalendar } = require('./business-calendar');
const { createDefinitionsService } = require('./rebuild-definitions');
const { problem } = require('./blueprint-draft');
const TEMPLATE_VERSION = 1;
const PROFILES = Object.freeze({ development: { field: 8, supply: 5, care: 5 }, flagship: { field: 30, supply: 15, care: 25 } });
function businessDate(now = new Date()) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
  return fields.year + '-' + fields.month + '-' + fields.day;
}
function activityDefinition(business) {
  if (!business || !Object.hasOwn(PROFILES, business.volumeProfile)) throw problem('Choose a supported business volume.');
  try { date(business.openingDate); } catch { throw problem('A valid business opening date is required.'); }
  const counts = PROFILES[business.volumeProfile], rules = [];
  const step = (key, entity, offsetDays, dependsOn, intent) => ({ key, entity, offsetDays, dependsOn, intent });
  const add = (cohort, count, divisionKey, steps) => {
    for (let index = 0; index < count; index++) {
      const key = cohort + '-' + String(index + 1).padStart(3, '0');
      rules.push({ key, divisionKey, startsOn: business.openingDate, cadence: { kind: 'monthly', day: 1 + (index * 5) % 28, every: 1 },
        steps: steps.map(item => ({ ...item, dependsOn: [...item.dependsOn], intent: { ...item.intent, cohort: key, templateVersion: TEMPLATE_VERSION } })) });
    }
  };
  add('field-job', counts.field, 'field-advisory', [
    step('estimate', 'Estimate', 0, [], { purpose: 'Quote a client service job' }),
    step('time', 'TimeActivity', 2, ['estimate'], { purpose: 'Record work on the quoted job' }),
    step('invoice', 'Invoice', 7, ['estimate', 'time'], { purpose: 'Bill completed service work', incomeMapping: 'serviceIncome' }),
    step('payment', 'Payment', 21, ['invoice'], { purpose: 'Collect the job invoice' }),
    step('deposit', 'Deposit', 22, ['payment'], { purpose: 'Deposit the collected payment', bankMapping: 'operatingBank' }),
  ]);
  add('supply-order', counts.supply, 'supply-workshop', [
    step('purchase-order', 'PurchaseOrder', 0, [], { purpose: 'Order workshop stock' }),
    step('bill', 'Bill', 3, ['purchase-order'], { purpose: 'Receive ordered stock and its supplier bill' }),
    step('sale', 'SalesReceipt', 5, ['bill'], { purpose: 'Sell received stock', incomeMapping: 'supplyIncome' }),
    step('bill-payment', 'BillPayment', 18, ['bill'], { purpose: 'Pay the stock supplier', bankMapping: 'operatingBank' }),
  ]);
  add('care-subscription', counts.care, 'care-plans', [
    step('invoice', 'Invoice', 0, [], { purpose: 'Bill the monthly care service', incomeMapping: 'careIncome' }),
    step('payment', 'Payment', 14, ['invoice'], { purpose: 'Collect the care-plan invoice' }),
  ]);
  return { version: 1, businessKey: 'harbour-pine-v1', openingDate: business.openingDate, rules };
}
function validatePreviewRequest(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !['connectionId', 'baseHash', 'fromDate', 'throughDate'].includes(key))) throw problem('Activity preview contains unsupported fields.');
  if (typeof input.connectionId !== 'string' || !/^[a-f0-9]{24}$/.test(input.connectionId)) throw problem('Reload the business plan before previewing activity.');
  if (input.baseHash !== null && (typeof input.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseHash))) throw problem('The loaded business-plan version is required.');
  try { date(input.fromDate); date(input.throughDate); } catch { throw problem('Choose valid preview dates.'); }
  if (input.throughDate < input.fromDate) throw problem('Choose an end date on or after the start date.');
  return input;
}
function previewBusinessActivity(view, input, today = businessDate()) {
  validatePreviewRequest(input);
  if (input.connectionId !== view.connectionId || input.baseHash !== (view.draft?.contentHash || null)) throw problem('The company or saved business plan changed. Reload before previewing activity.', 409);
  const source = view.draft || view.proposal;
  if (input.throughDate > today) throw problem('The preview cannot extend beyond the current business date (' + today + ').');
  if (input.fromDate < source.business.openingDate) throw problem('The preview cannot start before the business opens (' + source.business.openingDate + ').');
  const definition = activityDefinition(source.business);
  let plan;
  try { plan = planBusinessCalendar({ definition, scope: { realmId: view.realmId, environment: view.environment }, fromDate: input.fromDate, throughDate: input.throughDate, today }); }
  catch (error) { throw problem(error.status === 400 ? error.message : 'Business activity could not be planned.'); }
  const volumes = createDefinitionsService().getVolumeProfiles();
  const target = volumes.profiles.find(profile => profile.key === source.business.volumeProfile);
  if (!target || definition.rules.reduce((sum, rule) => sum + rule.steps.length, 0) !== target.targetTransactionsPerMonth) throw problem('The activity template and approved volume targets no longer agree.', 409);
  const totals = {};
  for (const event of plan.events) totals[event.entity] = (totals[event.entity] || 0) + 1;
  return { ...plan, ...describeBusinessActivity(plan), connectionId: view.connectionId, templateVersion: TEMPLATE_VERSION, today,
    source: { kind: view.draft ? 'saved_draft' : 'proposal', blueprintHash: view.draft?.contentHash || null, blueprintVersion: view.draft?.version || null, volumeProfile: source.business.volumeProfile },
    monthlyTarget: target.targetTransactionsPerMonth, totals, baselineCompared: false,
    limitations: [
      'These proposed activity patterns have not been activated. Counts describe scheduled records, not missing records to create.',
      'Existing company records have not been compared with this schedule. Earlier prerequisites need saved evidence before any follow-up can run.',
      'Proposed quantities and prices are not approved transaction policy. Actual parties, items, tax treatment and account mappings still require validation.',
      'Credits, returns, late or partial payments, retainer accounting, monthly close, bank reconciliation and other coverage requirements remain to be planned.',
    ] };
}
module.exports = { activityDefinition, previewBusinessActivity, validatePreviewRequest, businessDate, TEMPLATE_VERSION };
