'use strict';

// Pure planning only. This module cannot authorize writes or certify a business period.
const crypto = require('node:crypto');
const DAY = 86400000;
const ENTITIES = new Set(['Estimate', 'PurchaseOrder', 'Invoice', 'SalesReceipt', 'Bill', 'Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Deposit', 'JournalEntry', 'TimeActivity']);
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
function fail(message) { const error = new Error(message); error.status = 400; throw error; }
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('A calendar date must use YYYY-MM-DD');
  if (value < '1900-01-01' || value > '2200-12-31') fail('Calendar dates must be between 1900 and 2200');
  const stamp = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) fail('Invalid calendar date');
  return stamp;
}
function shift(value, days) { return new Date(date(value) + days * DAY).toISOString().slice(0, 10); }
function canonical(value, depth = 0) {
  if (depth > 15) fail('Blueprint data is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Unsupported blueprint key');
      return JSON.stringify(key) + ':' + canonical(value[key], depth + 1);
    }).join(',') + '}';
  }
  fail('Blueprint values must be plain JSON');
}
function hash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function object(value, name) { if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(name + ' must be an object'); }
function keys(value, allowed, name) { object(value, name); if (Object.keys(value).some(key => !allowed.includes(key))) fail(name + ' contains an unsupported field'); }
function identifier(value, name) { if (typeof value !== 'string' || !KEY.test(value)) fail(name + ' must be a stable lowercase key'); }
function validateCalendarDefinition(definition) {
  keys(definition, ['version', 'businessKey', 'openingDate', 'rules'], 'Calendar definition');
  if (definition.version !== 1) fail('Unsupported calendar definition version');
  identifier(definition.businessKey, 'Business key'); date(definition.openingDate);
  if (!Array.isArray(definition.rules) || !definition.rules.length || definition.rules.length > 200) fail('A calendar needs 1 to 200 activity rules');
  if (Buffer.byteLength(canonical(definition)) > 1000000) fail('Calendar definition exceeds its size budget');
  const ruleKeys = new Set();
  for (const rule of definition.rules) {
    keys(rule, ['key', 'divisionKey', 'startsOn', 'endsOn', 'cadence', 'steps'], 'Activity rule');
    identifier(rule.key, 'Rule key'); identifier(rule.divisionKey, 'Division key');
    if (ruleKeys.has(rule.key)) fail('Activity rule keys must be unique'); ruleKeys.add(rule.key);
    date(rule.startsOn);
    if (rule.startsOn < definition.openingDate) fail('Activity cannot begin before the business opening date');
    if (rule.endsOn !== undefined && (date(rule.endsOn) < date(rule.startsOn))) fail('Activity end precedes its start');
    const cadence = rule.cadence;
    if (cadence?.kind === 'monthly') {
      keys(cadence, ['kind', 'day', 'every'], 'Monthly cadence');
      if (!Number.isInteger(cadence.day) || cadence.day < 1 || cadence.day > 31) fail('Monthly day must be 1 to 31');
      if (!Number.isInteger(cadence.every) || cadence.every < 1 || cadence.every > 12) fail('Monthly interval must be 1 to 12');
    } else if (cadence?.kind === 'weekly') {
      keys(cadence, ['kind', 'every'], 'Weekly cadence');
      if (!Number.isInteger(cadence.every) || cadence.every < 1 || cadence.every > 52) fail('Weekly interval must be 1 to 52');
    } else fail('Unsupported activity cadence');
    if (!Array.isArray(rule.steps) || !rule.steps.length || rule.steps.length > 20) fail('An activity needs 1 to 20 steps');
    const stepMap = new Map();
    for (const step of rule.steps) {
      keys(step, ['key', 'entity', 'offsetDays', 'dependsOn', 'intent'], 'Activity step');
      identifier(step.key, 'Step key');
      if (stepMap.has(step.key)) fail('Step keys must be unique within an activity');
      if (!ENTITIES.has(step.entity)) fail('Unsupported business record type');
      if (!Number.isInteger(step.offsetDays) || step.offsetDays < 0 || step.offsetDays > 365) fail('Step offset must be 0 to 365 days');
      if (!Array.isArray(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length) fail('Dependencies must be a unique list');
      for (const dependency of step.dependsOn) {
        const parent = stepMap.get(dependency);
        if (!parent || parent.offsetDays > step.offsetDays) fail('Dependencies must refer to earlier steps dated on or before this step');
      }
      const requiredParent = { Payment: 'Invoice', BillPayment: 'Bill', CreditMemo: 'Invoice', VendorCredit: 'Bill', Deposit: 'Payment' }[step.entity];
      if (requiredParent && !step.dependsOn.some(key => stepMap.get(key)?.entity === requiredParent)) fail(step.entity + ' needs its originating ' + requiredParent + ' dependency');
      object(step.intent, 'Business intent');
      if (!Object.keys(step.intent).length) fail('Business intent cannot be empty');
      stepMap.set(step.key, step);
    }
  }
  return { definitionHash: hash(definition) };
}
function validateScope(scope) {
  keys(scope, ['realmId', 'environment'], 'Company scope');
  if (typeof scope.realmId !== 'string' || !/^\d{1,30}$/.test(scope.realmId) || !['production', 'sandbox'].includes(scope.environment)) fail('Exact company and environment are required');
}
function occurs(rule, day) {
  if (day < rule.startsOn || (rule.endsOn && day > rule.endsOn)) return false;
  if (rule.cadence.kind === 'weekly') return ((date(day) - date(rule.startsOn)) / DAY) % (7 * rule.cadence.every) === 0;
  const current = new Date(date(day)); const start = new Date(date(rule.startsOn));
  const months = (current.getUTCFullYear() - start.getUTCFullYear()) * 12 + current.getUTCMonth() - start.getUTCMonth();
  const lastDay = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)).getUTCDate();
  return months % rule.cadence.every === 0 && current.getUTCDate() === Math.min(rule.cadence.day, lastDay);
}
function planBusinessCalendar({ definition, scope, fromDate, throughDate, today, limit = 10000 }) {
  validateScope(scope);
  const { definitionHash } = validateCalendarDefinition(definition);
  const start = date(fromDate), end = date(throughDate); date(today);
  if (fromDate < definition.openingDate || end < start || throughDate > today || end - start > 366 * DAY) fail('Plan an elapsed period of no more than 367 calendar days after opening');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) fail('Activity budget must be 1 to 10000');
  const events = [], future = [], prerequisites = new Map();
  let outputBytes = 0;
  const accountOutput = event => {
    outputBytes += Buffer.byteLength(canonical(event));
    if (outputBytes > 8000000) fail('Calendar output size budget exceeded; shorten the period');
  };
  // Look back far enough to retain payments and other obligations from prior periods.
  const lower = Math.max(date(definition.openingDate), start - 365 * DAY);
  for (const rule of [...definition.rules].sort((a, b) => a.key.localeCompare(b.key, 'en'))) {
    for (let stamp = lower; stamp <= end; stamp += DAY) {
      const occurrence = new Date(stamp).toISOString().slice(0, 10);
      if (!occurs(rule, occurrence)) continue;
      const logicalKey = stepKey => hash({ ...scope, businessKey: definition.businessKey, ruleKey: rule.key, occurrence, stepKey });
      const occurrenceEvents = new Map();
      for (const [order, step] of rule.steps.entries()) {
        const txnDate = shift(occurrence, step.offsetDays);
        const event = {
          logicalKey: logicalKey(step.key), ruleKey: rule.key, stepKey: step.key,
          divisionKey: rule.divisionKey, occurrence, txnDate, entity: step.entity,
          dependsOn: step.dependsOn.map(logicalKey), order,
          intent: JSON.parse(canonical(step.intent)),
        };
        const { order: _order, ...content } = event;
        event.fingerprint = hash(content);
        occurrenceEvents.set(event.logicalKey, event);
        if (txnDate < fromDate) continue;
        const retainParents = child => {
          for (const key of child.dependsOn) {
            const parent = occurrenceEvents.get(key);
            if (parent.txnDate < fromDate && !prerequisites.has(key)) {
              accountOutput(parent); prerequisites.set(key, parent); retainParents(parent);
            }
          }
        };
        retainParents(event); accountOutput(event);
        (txnDate > throughDate ? future : events).push(event);
        if (events.length + future.length + prerequisites.size > limit) fail('Activity budget exceeded; shorten the period rather than dropping activity');
      }
    }
  }
  const sort = (a, b) => a.txnDate.localeCompare(b.txnDate) || a.occurrence.localeCompare(b.occurrence) || a.ruleKey.localeCompare(b.ruleKey, 'en') || a.order - b.order;
  events.sort(sort); future.sort(sort);
  const result = { version: 1, scope: { ...scope }, businessKey: definition.businessKey, definitionHash, fromDate, throughDate, events, future, prerequisites: [...prerequisites.values()].sort(sort) };
  return { ...result, planHash: hash(result), executable: false, calendarVerified: false };
}

// The caller must supply a complete server-owned managed-record ledger for these keys.
// A matching record is reusable only after its saved content and references were verified.
function reconcileCalendarPlan(plan, ledger) {
  verifyPlan(plan);
  if (!ledger || ledger.complete !== true || ledger.scope?.realmId !== plan.scope.realmId || ledger.scope?.environment !== plan.scope.environment || !Array.isArray(ledger.records)) fail('A complete company-scoped managed-record ledger is required');
  const expected = new Map([...plan.events, ...plan.future, ...plan.prerequisites].map(event => [event.logicalKey, event]));
  const expectedKeys = [...expected.keys()].sort();
  const expectedKeySet = new Set(expectedKeys);
  if (!Array.isArray(ledger.requestedKeys) || canonical([...new Set(ledger.requestedKeys)].sort()) !== canonical(expectedKeys)) fail('Managed-record lookup must cover every planned and dependency key');
  const records = new Map(), physicalRecords = new Set();
  for (const record of ledger.records) {
    if (!expectedKeySet.has(record.logicalKey) || records.has(record.logicalKey)) fail('Managed-record lookup returned unrelated or duplicate keys');
    if (typeof record.qboId === 'string' && record.qboId) {
      const physicalKey = canonical([record.entity, record.qboId]);
      if (physicalRecords.has(physicalKey)) fail('Different activities cannot share one physical managed record');
      physicalRecords.add(physicalKey);
    }
    records.set(record.logicalKey, record);
  }
  const planned = new Map(plan.events.map(event => [event.logicalKey, event]));
  const priorMemo = new Map(), savedMemo = new Map();
  const dependencyVerified = (key, allowPlanned) => {
    const memo = allowPlanned ? priorMemo : savedMemo;
    if (memo.has(key)) return memo.get(key);
    if (allowPlanned && planned.has(key)) return true;
    const parent = records.get(key), intent = expected.get(key);
    // Mark false before traversal to fail closed even for a corrupt saved dependency cycle.
    memo.set(key, false);
    const valid = !!(parent && intent && parent.state === 'verified' && typeof parent.qboId === 'string' && parent.qboId && parent.fingerprint === intent.fingerprint && parent.entity === intent.entity && intent.dependsOn.every(parentKey => dependencyVerified(parentKey, allowPlanned)));
    memo.set(key, valid); return valid;
  };
  const actions = plan.events.map(event => {
    const record = records.get(event.logicalKey);
    const reasons = [];
    if (record && (record.fingerprint !== event.fingerprint || record.entity !== event.entity)) reasons.push('Existing managed record differs from the planned activity');
    if (record && (record.state !== 'verified' || typeof record.qboId !== 'string' || !record.qboId)) reasons.push('Existing activity requires read-back or uncertain-write recovery');
    if (!event.dependsOn.every(key => dependencyVerified(key, !record))) reasons.push(record ? 'Saved activity needs verified original relationships' : 'Prior-period dependency is not verified');
    return { ...event, action: reasons.length ? 'blocked' : record ? 'reuse' : 'create', reasons, qboId: record?.qboId || null };
  });
  const byKey = new Map(actions.map(action => [action.logicalKey, action]));
  for (const action of actions) {
    if (action.dependsOn.some(key => byKey.get(key)?.action === 'blocked')) {
      action.action = 'blocked'; action.reasons.push('An earlier required activity is blocked');
    }
  }
  return { ...plan, actions, blocked: actions.some(action => action.action === 'blocked'), executable: false, calendarVerified: false };
}
function verifyPlan(plan) {
  validateScope(plan.scope);
  const { version, scope, businessKey, definitionHash, fromDate, throughDate, events, future, prerequisites } = plan;
  if (version !== 1 || !Array.isArray(events) || !Array.isArray(future) || !Array.isArray(prerequisites) || events.length + future.length + prerequisites.length > 10000 || hash({ version, scope, businessKey, definitionHash, fromDate, throughDate, events, future, prerequisites }) !== plan.planHash) fail('The saved calendar plan changed or has an unsupported version');
}
function compareCalendarPlans(previous, next) {
  verifyPlan(previous); verifyPlan(next);
  if (canonical(previous.scope) !== canonical(next.scope) || previous.businessKey !== next.businessKey || previous.fromDate !== next.fromDate || previous.throughDate !== next.throughDate) fail('Compare revisions for the same company, business and exact period');
  const all = plan => new Map([...plan.prerequisites, ...plan.events, ...plan.future].map(event => [event.logicalKey, event]));
  const before = all(previous), after = all(next);
  const removed = [...before.values()].filter(event => !after.has(event.logicalKey));
  const added = [...after.values()].filter(event => !before.has(event.logicalKey));
  const changed = [...after.values()].filter(event => before.has(event.logicalKey) && before.get(event.logicalKey).fingerprint !== event.fingerprint).map(event => ({ before: before.get(event.logicalKey), after: event }));
  return { removed, added, changed, requiresReview: !!(removed.length || added.length || changed.length), executable: false };
}
module.exports = { planBusinessCalendar, reconcileCalendarPlan, compareCalendarPlans, validateCalendarDefinition, canonical, hash, date, shift };
