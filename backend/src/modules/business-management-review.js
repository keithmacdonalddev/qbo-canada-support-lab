'use strict';
// The accountant's daily management review: the owner's intent as a short job description,
// live measures of it computed from the local company mirror (no QuickBooks calls), today's
// plan that the day's slices follow, and capability requests for gaps no tool can close.
// Owner direction 2026-10-30: review the business data every day against the app's intent.
// Requirements: docs/plans/continuous-business-operator-completion-2026-10-24.md §2 and §8.
const { hash, shift } = require('./business-calendar');
const cadence = require('./business-agent-cadence');

// One short block, in every review's instructions.
const jobDescription = () => [require('./business-owner-intent').readOwnerIntent(), 'Every review expires historical blocked beliefs. Recheck context.beliefChecks, current build status and eligible choices. When work is due, attempt one real governed preparation for independent eligible work before concluding a retained validation note blocks sales. Keep the original decision key for retries; never replace saved or unknown writes. A resolved capability means available code unless evidence separately establishes a business outcome. Reopened failures require a specific fresh action check.'];
const REQUIREMENTS = Object.freeze(['R01', 'R02', 'R04', 'R05', 'R06', 'R11']);
const FINDING_STATUS = Object.freeze(['on-track', 'attention', 'gap']);
const CHANGE_AREAS = Object.freeze(['customers', 'suppliers', 'items', 'sales-mix', 'scenario', 'collections', 'payables', 'stock', 'close', 'other']);
const PRIORITIES = Object.freeze(['high', 'medium', 'low']);

// Responsibility -> tools that exist, and the known gaps from the tool catalog
// (business-agent-catalog.js). The accountant files requests for gaps it confirms.
const RESPONSIBILITIES = Object.freeze([
 {key:'sales',responsibility:'Sales and collections',tools:['manageQboRecord','prepareBusinessActivity','getObligations'],missing:[]},
 {key:'payables',responsibility:'Purchases and payables',tools:['manageQboRecord','getObligations'],missing:[]},
 {key:'inventory',responsibility:'Stock',tools:['getBusinessActivityChoices','getQboEntitySchema','manageQboRecord (inventory gate applies)'],missing:['Inventory adjustments and returns require supported tools and enabled gates']},
 {key:'banking',responsibility:'Banking',tools:['manageQboRecord','getCloseChecklist','recordCloseChecklistEvidence'],missing:['Native bank reconciliation requires manual evidence; never infer completion']},
 {key:'master-data',responsibility:'Lists, classes and locations',tools:['manageQboRecord','getQboEntitySchema'],missing:[]},
 {key:'close',responsibility:'Close and evidence',tools:['prepareBusinessPeriod','executeBusinessPeriod','getCloseChecklist','recordCloseChecklistEvidence'],missing:[]},
 {key:'planning',responsibility:'Planning, breadth and build list',tools:['getManagementReview','recordDailyPlan','requestCapability','reviewCapability','getCoverageSituations','getWeeklyCoverage','findBusinessOperation'],missing:[]}
]);

// Management review time and attempts live with the cadence (business-agent-cadence.js).
const { MANAGEMENT_MINUTES, MANAGEMENT_ATTEMPTS, managementMinutes, managementAt } = cadence;

const clip = (value, max) => String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const bad = message => Object.assign(new Error(message), { status: 400, code: 'BUSINESS_PLAN_INVALID' });

// ---------------------------------------------------------------------------
// Tool payloads
// ---------------------------------------------------------------------------
function dailyPlanEvent(input, day) {
  const findings = Array.isArray(input?.findings) ? input.findings : [], changes = Array.isArray(input?.changes) ? input.changes : [];
  if (!findings.length || findings.length > 12) throw bad('Record one to twelve findings against the requirements.');
  if (changes.length > 10) throw bad('Keep today’s plan to at most ten changes.');
  const note = clip(input.ownerNote, 1200);
  if (!note) throw bad('Write a short owner note for today.');
  const plan = {
    day,
    findings: findings.map(row => {
      if (!REQUIREMENTS.includes(row?.requirement) || !FINDING_STATUS.includes(row?.status)) throw bad('Each finding names a requirement and a status.');
      return { requirement: row.requirement, status: row.status, finding: clip(row.finding, 400) };
    }),
    changes: changes.map(row => {
      if (!CHANGE_AREAS.includes(row?.area)) throw bad('Each change names a supported area.');
      return { area: row.area, change: clip(row.change, 300), ...(Number.isSafeInteger(row.count) && row.count > 0 ? { count: Math.min(row.count, 500) } : {}) };
    }),
  };
  if (plan.findings.some(row => !row.finding) || plan.changes.some(row => !row.change)) throw bad('Findings and changes need text.');
  return { title: 'Today’s plan · ' + cadence.dayLabel(day), detail: note, data: plan };
}
function capabilityRequestEvent(input) {
  const key = String(input?.key || '');
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(key)) throw bad('Give the request a short stable key.');
  if (!REQUIREMENTS.includes(input.requirement) || !PRIORITIES.includes(input.priority)) throw bad('Name the requirement and a priority.');
  const data = { key, requirement: input.requirement, priority: input.priority, missing: clip(input.missing, 300), feature: clip(input.feature, 200), why: clip(input.why, 600), status: 'open' };
  if (!data.missing || !data.feature || !data.why) throw bad('Say what is missing, which QuickBooks feature or report it covers, and why it matters.');
  return { title: clip('Build: ' + data.missing, 160), detail: data.why, data };
}

// What every accountant review sees of today's plan: only today's, compactly.
function planContext(plan, day) {
  if (!plan || plan.day !== day) return null;
  return { day, recordedAt: plan.at || null, changes: (plan.changes || []).slice(0, 10), focus: (plan.findings || []).filter(row => row.status !== 'on-track').slice(0, 8).map(row => row.requirement + ': ' + row.finding) };
}
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
function openRequests(events = []) {
 return require('./business-capability-review').fold(events).filter(r=>r.status!=='resolved').sort((a,b)=>(PRIORITY_ORDER[a.priority]??3)-(PRIORITY_ORDER[b.priority]??3));
}
function recentResolutions(events=[]) {return require('./business-capability-review').fold(events).filter(r=>r.status==='resolved').sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,20);}
// ---------------------------------------------------------------------------
// Measures from local mirrored records (pure)
// ---------------------------------------------------------------------------
const LIST_ENTITY = Object.freeze({ customers: 'Customer', vendors: 'Vendor', items: 'Item', accounts: 'Account', classes: 'Class', departments: 'Department', terms: 'Term', taxCodes: 'TaxCode', employees: 'Employee', preferences: 'Preferences' });
const NOT_MIRRORED = 'Not kept in the local company copy; check it on the Coverage page.';
const SALES = new Set(['Invoice', 'SalesReceipt']), RETURNS = new Set(['CreditMemo', 'RefundReceipt']), COSTS = new Set(['Bill', 'Purchase']);
const LISTS = new Set(['Customer', 'Vendor', 'Item', 'Account', 'Employee', 'Class', 'Department', 'Term', 'PaymentMethod', 'TaxCode', 'TaxRate', 'Preferences', 'CompanyInfo']);
const cents = value => { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const isDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
function fieldsOf(row) {
  const r = row.record || {}, s = row.summary || {};
  return { txnDate: isDay(s.txnDate) ? s.txnDate : isDay(r.TxnDate) ? r.TxnDate : null, dueDate: isDay(s.dueDate) ? s.dueDate : isDay(r.DueDate) ? r.DueDate : null,
    amount: Number.isSafeInteger(s.amountCents) ? s.amountCents : cents(r.TotalAmt), balance: Number.isSafeInteger(s.balanceCents) ? s.balanceCents : cents(r.Balance) };
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
function agingOf(rows, day) {
  const buckets = { current: { count: 0, cents: 0 }, '1-30': { count: 0, cents: 0 }, '31-60': { count: 0, cents: 0 }, '61-90': { count: 0, cents: 0 }, '90+': { count: 0, cents: 0 } };
  let open = 0, openCents = 0, partlyPaid = 0, overdue = 0;
  for (const row of rows) {
    const f = fieldsOf(row);if (f.balance <= 0) continue;
    open++;openCents += f.balance;if (f.balance < f.amount) partlyPaid++;
    const late = f.dueDate ? daysBetween(f.dueDate, day) : 0;if (late > 0) overdue++;
    const key = late <= 0 ? 'current' : late <= 30 ? '1-30' : late <= 60 ? '31-60' : late <= 90 ? '61-90' : '90+';
    buckets[key].count++;buckets[key].cents += f.balance;
  }
  return { open, openCents, overdue, partlyPaid, buckets };
}
function priorPeriod(day) {
  const [y, m, d] = day.split('-').map(Number), prior = new Date(Date.UTC(y, m - 2, 1)), last = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const start = prior.toISOString().slice(0, 10);
  return { from: start, through: start.slice(0, 8) + String(Math.min(d, last)).padStart(2, '0') };
}
function totalsBetween(rows, from, through) {
  const out = { salesCents: 0, returnsCents: 0, expensesCents: 0, sales: 0, expenses: 0 };
  for (const row of rows) {
    const f = fieldsOf(row);if (!f.txnDate || f.txnDate < from || f.txnDate > through) continue;
    if (SALES.has(row.entity)) { out.salesCents += f.amount; out.sales++; }
    else if (RETURNS.has(row.entity)) out.returnsCents += f.amount;
    else if (COSTS.has(row.entity)) { out.expensesCents += f.amount; out.expenses++; }
  }
  return out;
}
// Records dated `day` by type: transactions by business date, list entries by their QuickBooks create date.
function volumeOn(rows, day) {
  const byEntity = {};let records = 0;
  for (const row of rows) {
    const dated = LISTS.has(row.entity) ? String(row.record?.MetaData?.CreateTime || '').slice(0, 10) : fieldsOf(row).txnDate;
    if (dated !== day) continue;
    byEntity[row.entity] = (byEntity[row.entity] || 0) + 1;records++;
  }
  return { day, records, byEntity };
}
const taxCodesOf = record => new Set((Array.isArray(record?.Line) ? record.Line : []).map(line => line?.SalesItemLineDetail?.TaxCodeRef?.value).filter(Boolean));
function scenariosOf(rows, day) {
  const since = shift(day, -30), recent = row => { const d = fieldsOf(row).txnDate; return d && d >= since && d <= day; };
  const count = (entity, extra = () => true) => rows.filter(row => row.entity === entity && recent(row) && extra(row)).length;
  return { windowDays: 30, creditMemos: count('CreditMemo'), refunds: count('RefundReceipt'), supplierCredits: count('VendorCredit'), deposits: count('Deposit'), transfers: count('Transfer'), journalEntries: count('JournalEntry'), estimates: count('Estimate'), purchaseOrders: count('PurchaseOrder'),
    mixedTaxSales: count('Invoice', row => taxCodesOf(row.record).size > 1) + count('SalesReceipt', row => taxCodesOf(row.record).size > 1),
    partPaidInvoices: rows.filter(row => row.entity === 'Invoice' && (f => f.balance > 0 && f.balance < f.amount)(fieldsOf(row))).length,
    partPaidBills: rows.filter(row => row.entity === 'Bill' && (f => f.balance > 0 && f.balance < f.amount)(fieldsOf(row))).length };
}
function stockOf(rows) {
  const stocked = rows.filter(row => row.entity === 'Item' && row.record?.Type === 'Inventory' && row.record?.Active !== false);
  const qty = row => Number(row.record?.QtyOnHand) || 0, reorder = row => Number(row.record?.ReorderPoint) || 0;
  const out = stocked.filter(row => qty(row) <= 0), low = stocked.filter(row => qty(row) > 0 && qty(row) <= Math.max(reorder(row), 0) && reorder(row) > 0);
  return { stockedItems: stocked.length, outOfStock: out.length, low: low.length, outOfStockNames: out.slice(0, 5).map(row => clip(row.record?.Name, 60)) };
}
function partiesOf(rows) {
  const active = entity => rows.filter(row => row.entity === entity && row.record?.Active !== false).length;
  const items = rows.filter(row => row.entity === 'Item' && row.record?.Active !== false);
  return { customers: active('Customer'), suppliers: active('Vendor'), items: items.length, serviceItems: items.filter(row => row.record?.Type === 'Service').length, stockedItems: items.filter(row => row.record?.Type === 'Inventory').length, employees: active('Employee') };
}
// Group mirrored rows into the coverage module's source shape and score it (coverage.scoreCoverage is pure).
function coverageFromRecords(rows, day, mirrored = require('./business-agent-sync').ENTITIES) {
  const coverage = require('./coverage'), have = new Set(mirrored), by = {};
  for (const row of rows) (by[row.entity] ||= []).push(row.record);
  const data = {};
  for (const name of Object.keys(coverage.LIST_SOURCES)) { const entity = LIST_ENTITY[name]; data[name] = entity && have.has(entity) ? { records: by[entity] || [] } : { records: [], error: NOT_MIRRORED }; }
  for (const entity of coverage.TXN_SOURCES) data[entity] = have.has(entity) ? { records: by[entity] || [] } : { records: [], error: NOT_MIRRORED };
  return coverage.scoreCoverage(data, { today: day });
}
function measuresFromRecords(rows, day) {
  const month = { from: day.slice(0, 8) + '01', through: day }, prior = priorPeriod(day);
  return { day, parties: partiesOf(rows), receivables: agingOf(rows.filter(row => row.entity === 'Invoice'), day), payables: agingOf(rows.filter(row => row.entity === 'Bill'), day),
    monthToDate: { ...month, ...totalsBetween(rows, month.from, month.through) }, priorMonthToDate: { ...prior, ...totalsBetween(rows, prior.from, prior.through) },
    yesterday: { ...volumeOn(rows, shift(day, -1)), target: cadence.dayRhythm(shift(day, -1)).target }, today: volumeOn(rows, day), stock: stockOf(rows), scenarios: scenariosOf(rows, day) };
}
// Coverage gaps, compact for the model: the areas not fully covered and their unused features.
function compactCoverage(result, limit = 30) {
  if (!result) return null;
  const gaps = [];let unread = 0;
  for (const area of result.areas || []) {
    if (['covered', 'internal', 'unmeasured'].includes(area.status)) continue;
    for (const signal of area.signals || []) {
      if (signal.status === 'error') { unread++; continue; }
      if (!['missing', 'stale'].includes(signal.status)) continue;
      gaps.push({ area: area.name, feature: signal.label, status: signal.status, fill: signal.fill === 'assistant' ? 'accountant' : 'quickbooks', ...(signal.last ? { last: signal.last } : {}), ...(signal.blockedBy ? { blockedBy: signal.blockedBy } : {}), ...(area.linkedReports?.length ? { reports: area.linkedReports.slice(0, 3) } : {}) });
    }
  }
  // Gaps the accountant can fill come first: those are today's mix.
  gaps.sort((a, b) => (a.fill === b.fill ? 0 : a.fill === 'accountant' ? -1 : 1));
  return { asOf: result.asOf, source: result.source || 'quickbooks', areas: result.summary?.areas || {}, gapCount: gaps.length, gaps: gaps.slice(0, limit), unreadSignals: unread };
}
const PROBLEM_KINDS = new Set(['attention', 'review-yielded', 'review-paused', 'review-cancelled']);
function problemsOf(events = [], nowMs = Date.now()) {
  const since = nowMs - 2 * 86400000, rows = events.filter(row => PROBLEM_KINDS.has(row?.kind) && Date.parse(row.at) >= since);
  const byKind = {};for (const row of rows) byKind[row.kind] = (byKind[row.kind] || 0) + 1;
  // Recorded limitations ("… unavailable", "… blocked") are the gaps the accountant already hit.
  const limits = events.filter(row => row?.kind === 'management-decision' && /unavailable|blocked|missing|cannot/i.test(String(row.title) + ' ' + String(row.detail))).slice(0, 5).map(row => clip(row.title, 140));
  return { last2Days: byKind, recent: rows.slice(0, 5).map(row => ({ kind: row.kind, title: clip(row.title, 120), detail: clip(row.detail, 200), at: row.at })), recordedLimitations: limits };
}
function ownerAnswersOf(decisions = []) {
  return decisions.filter(row => row?.response).slice(0, 6).map(row => ({ title: clip(row.title, 140), choice: row.status, note: clip(row.response?.detail, 300) }));
}
// The management review's context: measures, coverage gaps, problems, answers, the tool map and open requests.
function managementContext({ snapshot = null, today = null, events = [], decisions = [], requests = [], nowMs = Date.now(), error = null } = {}) {
  return {
    asOf: snapshot?.asOf || null,
    ...(snapshot ? {} : { unavailable: true, reason: clip(error || 'The local company measures could not be read; use the tools.', 200) }),
    ...(snapshot?.truncated ? { incomplete: 'The local company copy was only partly read.' } : {}),
    measures: snapshot?.measures || null,
    today: today && !today.unavailable ? { label: today.label, target: today.target, saved: today.saved, verified: today.verified, reserved: today.reserved, byEntity: today.byEntity, slotCount: today.slotCount } : null,
    coverage: compactCoverage(snapshot?.coverage || null),
    situations: snapshot?.situations ? {...snapshot.situations,rows:snapshot.situations.rows.slice(0,12)} : null, weekly: snapshot?.weekly ? {...snapshot.weekly,rows:snapshot.weekly.rows.filter(r=>r.status!=='covered').slice(0,15)} : null,
    recentResolutions: recentResolutions(requests),
    problems: problemsOf(events, nowMs),
    ownerAnswers: ownerAnswersOf(decisions),
    responsibilities: RESPONSIBILITIES,
    capabilityRequests: openRequests(requests).slice(0, 20).map(({ key, priority, missing, requirement, errorDetail, count, firstAt, lastAt }) => ({ key, priority, requirement, missing, ...(errorDetail ? { errorDetail, count, firstAt, lastAt } : {}) })),
  };
}

// ---------------------------------------------------------------------------
// Snapshot from the local company mirror: at most once per Halifax day per company, or on demand.
// ---------------------------------------------------------------------------
const ROW_LIMIT = 40000, LOOKBACK_DAYS = 365;
const snapshots = new Map(), inflight = new Map();
const scopeKey = scope => hash({ environment: scope.environment, realmId: String(scope.realmId), connectionId: String(scope.connectionId) });
async function readSnapshot(scope, Records, day, sources={}, nowMs=Date.now()) {

  const rows = await Records.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId })
    .select('entity qboId deleted record summary').limit(ROW_LIMIT).maxTimeMS(20000).lean();
  const liveRows=rows.filter(r=>r.deleted!==true&&r.record?.status!=='Deleted');
  const coverage = { ...coverageFromRecords(liveRows, day), source: 'local-mirror', checkedAt: new Date().toISOString(), lookbackDays: LOOKBACK_DAYS };
  const breadth=require('./coverage'), input={records:rows,sources,truncated:rows.length>=ROW_LIMIT}, opts={today:day,now:new Date(nowMs)};
  const situations=breadth.situations(input,opts),weekly=breadth.weekly(input,{...opts,situations});
  const collections=liveRows.filter(r=>r.entity==='Payment'&&fieldsOf(r).txnDate===day);
  return { collections:{count:collections.length,cents:collections.reduce((sum,r)=>sum+fieldsOf(r).amount,0)}, situations, weekly, asOf: new Date(nowMs).toISOString(), day, truncated: rows.length >= ROW_LIMIT, records: rows.length, measures: measuresFromRecords(liveRows, day), coverage };
}
async function snapshotFor(scope, { Records, nowMs = Date.now(), refresh = false, sources = {} } = {}) {
  if (!Records) throw new Error('The local company copy is unavailable.');
  const key = scopeKey(scope)+':'+hash(sources), day = cadence.localParts(nowMs).date, hit = snapshots.get(key);
  if (!refresh && hit && hit.day === day && nowMs-Date.parse(hit.asOf)<60000) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const run = readSnapshot(scope, Records, day, sources, nowMs).then(value => { if (snapshots.size >= 20) snapshots.clear(); snapshots.set(key, value); return value; }).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}
// The work list's feature check when no QuickBooks coverage check ran since the server started.
function cachedCoverage(scope) {const prefix=scopeKey(scope)+':',hits=[...snapshots].filter(([key])=>key.startsWith(prefix)).map(([,hit])=>hit).sort((a,b)=>String(b.asOf).localeCompare(String(a.asOf)));return hits[0]?.coverage||null;}
// Build today's snapshot in the background (once per day; failures are retried on the next call).
const warmed = new Map();
function warm(scope, Records, nowMs = Date.now()) {
  if (!Records) return;
  const key = scopeKey(scope), day = cadence.localParts(nowMs).date, last = warmed.get(key);
  if (snapshots.get(key)?.day === day || inflight.has(key) || (last && nowMs - last < 600000)) return;
  if (warmed.size >= 50) warmed.clear();
  warmed.set(key, nowMs);
  snapshotFor(scope, { Records, nowMs }).catch(() => {});
}

module.exports = { get JOB_DESCRIPTION(){return jobDescription();}, recentResolutions, REQUIREMENTS, FINDING_STATUS, CHANGE_AREAS, PRIORITIES, RESPONSIBILITIES, MANAGEMENT_MINUTES, MANAGEMENT_ATTEMPTS, managementMinutes, managementAt,
  dailyPlanEvent, capabilityRequestEvent, planContext, openRequests, coverageFromRecords, measuresFromRecords, compactCoverage, problemsOf, ownerAnswersOf, managementContext,
  snapshotFor, cachedCoverage, warm, _internal: { snapshots, warmed, agingOf, priorPeriod, volumeOn, scenariosOf } };
