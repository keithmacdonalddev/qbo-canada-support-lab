'use strict';
// Currency admission and home-currency proof. No settings/currency writes. Rates are
// observed through Exchangerate, never inferred from an old transaction or inverted.
const ISO = /^[A-Z]{3}$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const FOREIGN = new Set(['Customer', 'Vendor', 'Invoice', 'Bill', 'Payment', 'BillPayment', 'Deposit', 'Transfer']);
const TXNS = new Set(['Invoice', 'Bill', 'Payment', 'BillPayment', 'Deposit', 'Transfer']);
const currencyOf = (record, home = 'CAD') => record?.CurrencyRef?.value || home;
const exactMoney = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
const validRate = rate => typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 1000000 && /^\d+(?:\.\d{1,12})?$/.test(String(rate));
function fail(message) { throw Object.assign(new Error(message), { code: 'GENERAL_CURRENCY_UNVERIFIED', status: 409 }); }
function homeCents(amount, rate) {
  if (!Number.isSafeInteger(amount) || !validRate(rate)) fail('An exact amount and positive finite ExchangeRate are required.');
  const [whole, fraction = ''] = String(rate).split('.'), scale = 10n ** BigInt(fraction.length);
  const n = BigInt(Math.abs(amount)) * BigInt(whole + fraction), rounded = (n * 2n + scale) / (2n * scale);
  const out = Number(rounded) * Math.sign(amount);
  if (!Number.isSafeInteger(out)) fail('The home-currency amount exceeds exact money.');
  return out;
}
function rateKey(currency, day) { return currency + ':' + day; }
function observedRate(record, source, home, day) {
  if (record?.SourceCurrencyCode !== source || record?.TargetCurrencyCode !== home || record?.AsOfDate !== day || !validRate(record?.Rate)) fail('Exchangerate must prove ' + source + ' to ' + home + ' on ' + day + '.');
  return { SourceCurrencyCode: source, TargetCurrencyCode: home, AsOfDate: day, Rate: record.Rate, ...(record.MetaData ? { MetaData: record.MetaData } : {}) };
}
function currencyProblems(entity, op, payload, before, after, local, byRef, context) {
  const out = [], policy = context.currency || {}, home = policy.homeCurrency || 'CAD', record = after || before;
  if (!record) return out;
  const hasCurrency = Object.prototype.hasOwnProperty.call(payload, 'CurrencyRef');
  if (hasCurrency && (!payload.CurrencyRef || typeof payload.CurrencyRef !== 'object' || Array.isArray(payload.CurrencyRef) || !ISO.test(payload.CurrencyRef.value || '') || Object.keys(payload.CurrencyRef).some(key => !['value', 'name'].includes(key)))) out.push('CurrencyRef must be a non-null reference with an existing ISO currency value.');
  const code = currencyOf(record, home), foreign = code !== home;
  const lookup = (kind, ref) => { const earlier = ref?.$ref ?? ref?.value?.$ref; return earlier ? byRef.get(earlier)?.after : local.get(kind, String(ref?.value)); };
  if (!ISO.test(code) || record.CurrencyRef && (typeof record.CurrencyRef !== 'object' || typeof record.CurrencyRef.value !== 'string')) out.push('CurrencyRef needs an existing three-letter currency code.');
  if (before && hasCurrency && currencyOf(before, home) !== code) out.push('Currency is immutable; create a separate party or transaction in the required currency.');
  if (foreign) {
    if (!FOREIGN.has(entity)) out.push('Only CAD records are supported for ' + entity + '; its foreign posting contract is not enabled.');
    if (policy.enabled !== true || home !== 'CAD') out.push('Only CAD records are supported unless observed Preferences.CurrencyPrefs.MultiCurrencyEnabled is true and home currency is CAD.');
    if (!(policy.currencies || []).includes(code)) out.push('Currency ' + code + ' is not already used in the synced company; currency creation is not allowed.');
    if (['Payment', 'BillPayment'].includes(entity)) {
      const targets = new Set();
      for (const line of Array.isArray(record.Line) ? record.Line : []) for (const link of Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : []) {
        const scalar = link.TxnId !== null && typeof link.TxnId !== 'object', target = scalar ? String(link.TxnId) : JSON.stringify(link.TxnId);
        const key = link.TxnType + ':' + target;
        if (targets.has(key)) out.push('Use one foreign settlement line per invoice or bill; combine duplicate applications.');
        targets.add(key);
        const source = scalar ? local.get(link.TxnType, target) : null;
        if (source) { const problem = settlementBasisProblem(source, code); if (problem) out.push(problem); }
      }
    }
    if (['Payment', 'BillPayment'].includes(entity) && (Array.isArray(record.Line) ? record.Line : []).some(line => (line.LinkedTxn || []).some(link => ['CreditMemo', 'VendorCredit'].includes(link.TxnType)))) out.push('Foreign credit applications need retained credit home-balance allocation and are held.');
    if (['Payment', 'BillPayment', 'Deposit'].includes(entity) && op !== 'create') out.push('Foreign settlement changes/removals need retained original allocation history and are held; create a new settlement.');
    if (['Invoice', 'Payment', 'Bill', 'BillPayment'].includes(entity)) {
      const type = ['Invoice', 'Payment'].includes(entity) ? 'Accounts Receivable' : 'Accounts Payable', key = type === 'Accounts Receivable' ? 'ARAccountRef' : 'APAccountRef';
      const matches = (policy.controls || []).filter(account => account.type === type && account.currency === code && (!record[key]?.value || String(record[key].value) === account.id));
      if (matches.length !== 1) out.push('Foreign ' + entity + ' requires one proven existing ' + code + ' ' + type + ' account.');
    }
    if (TXNS.has(entity)) {
      if (!validRate(record.ExchangeRate)) out.push('A foreign transaction needs a positive finite ExchangeRate observed from Exchangerate.');
      if (op === 'create' || payload.ExchangeRate !== undefined || payload.TxnDate !== undefined) {
        const observed = policy.rates?.[rateKey(code, record.TxnDate)];
        if (!observed || observed.Rate !== record.ExchangeRate || observed.SourceCurrencyCode !== code || observed.TargetCurrencyCode !== home || observed.AsOfDate !== record.TxnDate) out.push('ExchangeRate must match the observed Exchangerate for ' + code + ' to ' + home + ' on ' + record.TxnDate + '.');
      }
      if ((Array.isArray(record.Line) ? record.Line : []).some(line => lookup('Item', line?.[line.DetailType]?.ItemRef)?.Type === 'Inventory')) out.push('Foreign inventory needs a separate FIFO currency valuation proof and is held.');
    }
  } else if (record.ExchangeRate !== undefined && record.ExchangeRate !== 1) out.push('A home-currency transaction must have ExchangeRate 1.');
  for (const [kind, key] of [['Customer', 'CustomerRef'], ['Vendor', 'VendorRef']]) if (record[key]) {
    const party = lookup(kind, record[key]);
    if (party && currencyOf(party, home) !== code) out.push(key + ' currency must match the transaction CurrencyRef (' + code + ').');
  }
  for (const key of ['ARAccountRef', 'APAccountRef']) if (record[key]) {
    const account = lookup('Account', record[key]);
    if (account && currencyOf(account, home) !== code) out.push(key + ' currency must match ' + code + '.');
  }
  const bankRefs = [record.DepositToAccountRef, record.CheckPayment?.BankAccountRef, record.CreditCardPayment?.CCAccountRef, ...(entity === 'Transfer' ? [record.FromAccountRef, record.ToAccountRef] : [])].filter(Boolean);
  const banks = bankRefs.map(ref => lookup('Account', ref));
  for (const bank of banks) if (bank && ![home, code].includes(currencyOf(bank, home))) out.push('Bank currency must be home currency or the transaction currency, never a second foreign currency.');
  if (entity === 'Deposit' && foreign && banks[0] && currencyOf(banks[0], home) !== code) out.push('A foreign Deposit requires a bank in that same foreign currency.');
  if (entity === 'Transfer') {
    if (!exactMoney(record.Amount) || record.Amount === 0) out.push('Transfer Amount must be positive finite exact cents.');
    if (String(record.FromAccountRef?.value) === String(record.ToAccountRef?.value) && !record.FromAccountRef?.value?.$ref) out.push('A transfer needs two different accounts.');
    if (foreign && (banks.some(bank => bank && bank.AccountType !== 'Bank') || !banks.some(bank => bank && currencyOf(bank, home) === code))) out.push('A foreign transfer needs existing bank accounts, at least one in CurrencyRef; Amount is in that currency.');
  }
  for (const line of Array.isArray(record.Line) ? record.Line : []) {
    const account = lookup('Account', line?.[line.DetailType]?.AccountRef);
    if (account && ![home, code].includes(currencyOf(account, home))) out.push('A line account cannot introduce a second foreign currency.');
    if (foreign && entity === 'Deposit' && !(line.LinkedTxn || []).length && account && ['Bank', 'Accounts Receivable', 'Accounts Payable', 'Credit Card'].includes(account.AccountType)) out.push('A free foreign deposit line cannot bypass bank transfers or AR/AP settlement links.');
  }
  // An omitted currency must never route CAD money into an existing foreign bank.
  if (!foreign && banks.some(bank => bank && currencyOf(bank, home) !== home)) out.push('CurrencyRef must identify the foreign bank currency.');
  return out;
}
async function readCurrencyPolicy({ models, scope, session, requests = [], readRate }) {
  const query = filter => { let q = models.Records.find(filter); if (session) q = q.session(session); return q.select('entity qboId record').limit(501).maxTimeMS(3000).lean(); };
  if (!models.Records) return { enabled: false, homeCurrency: 'CAD', currencies: [], rates: {} };
  const rows = await query({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, deleted: false, $or: [{ entity: 'Preferences' }, { entity: 'Account' }] });
  if (rows.length > 500) fail('Currency/account enumeration exceeds its proof budget.');
  const prefs = rows.filter(row => row.entity === 'Preferences');
  const p = prefs.length === 1 ? prefs[0].record.CurrencyPrefs : null;
  const home = p?.HomeCurrency?.value, enabled = p?.MultiCurrencyEnabled === true;
  const currencies = [...new Set(rows.filter(row => row.entity === 'Account' && row.record.Active !== false).map(row => row.record.CurrencyRef?.value).filter(code => ISO.test(code || '')))];
  const rates = {};
  for (const { currency, day } of requests) {
    if (!currency || currency === home || !DAY.test(day || '') || !ISO.test(currency) || rates[rateKey(currency, day)]) continue;
    if (!enabled || home !== 'CAD' || !currencies.includes(currency)) continue;
    if (typeof readRate !== 'function') fail('An observed Exchangerate read is required before foreign transaction admission.');
    rates[rateKey(currency, day)] = observedRate(await readRate(scope, currency, day, { session }), currency, home, day);
  }
  const controls = rows.filter(row => row.entity === 'Account' && row.record.Active !== false && ['Accounts Receivable', 'Accounts Payable'].includes(row.record.AccountType)).map(row => ({ id: String(row.qboId), type: row.record.AccountType, currency: currencyOf(row.record, home || 'CAD') }));
  return { enabled, homeCurrency: home || 'CAD', currencies, rates, controls, preferences: prefs.length === 1 ? { Id: prefs[0].qboId, CurrencyPrefs: p } : null };
}
// Cache only within one governed service instance and company/day. Admission in a
// Mongo transaction uses the already observed value; it never performs network IO.
function createRateReader({ access, now = () => Date.now() }) {
  const cache = new Map();
  return async (scope, currency, day, { session } = {}) => {
    const key = JSON.stringify([scope.environment, scope.realmId, String(scope.connectionId), currency, day]);
    const existing = cache.get(key);
    if (existing && now() - existing.at <= 300000) return existing.record;
    if (session || !access) fail('Observe Exchangerate outside admission before sending this foreign transaction.');
    const client = await access.resolveClient(scope);
    const response = await require('./qbo-request-meter').runWithCaller('business-foreign-exchangerate', () => client.apiCall('GET', 'exchangerate?' + new URLSearchParams({ sourcecurrencycode: currency, asofdate: day })));
    const record = response?.ExchangeRate || response?.json?.ExchangeRate;
    cache.set(key, { at: now(), record });
    return record;
  };
}
module.exports = { FOREIGN, TXNS, currencyOf, validRate, homeCents, rateKey, observedRate, currencyProblems, readCurrencyPolicy, createRateReader };

// Convert account totals with bounded cent allocation. Each side still equals the
// independently validated HomeTotalAmt; a rounding cent cannot hide a wrong account.
function convertSide(entries, total, rate, sign) {
  const rows = entries.filter(([, amount]) => Math.sign(amount) === sign).map(([account, amount]) => ({ account, amount: Math.abs(amount), home: Math.abs(homeCents(amount, rate)) }));
  let remainder = total - rows.reduce((sum, row) => sum + row.home, 0);
  if (Math.abs(remainder) > rows.length) fail('Foreign posting rounding does not reconcile to HomeTotalAmt.');
  rows.sort((a, b) => (b.amount * rate - b.home) - (a.amount * rate - a.home) || a.account.localeCompare(b.account));
  if (remainder < 0) rows.reverse();
  for (const row of rows) { if (!remainder) break; const delta = Math.sign(remainder); row.home += delta; remainder -= delta; }
  if (remainder) fail('Foreign postings do not have a counterpart.');
  return rows.map(row => [row.account, row.home * sign]);
}
function foreignPostings(entity, record, ctx, native, cents) {
  const code = currencyOf(record), rate = record.ExchangeRate;
  if (!TXNS.has(entity) || !validRate(rate)) fail('Foreign posting rules are unavailable for ' + entity + '.');
  if ((Array.isArray(record.Line) ? record.Line : []).some(line => ctx.get('Item', String(line?.[line.DetailType]?.ItemRef?.value))?.Type === 'Inventory')) fail('Foreign inventory valuation is unavailable.');
  const amount = entity === 'Transfer' ? cents(record.Amount) : cents(record.TotalAmt);
  const total = homeCents(amount, rate);
  if (record.HomeTotalAmt !== undefined && cents(record.HomeTotalAmt) !== total) fail('HomeTotalAmt disagrees with TotalAmt and ExchangeRate.');
  const out = new Map(), add = (account, n) => { if (!n) return; if (!account) fail('Foreign posting account is not proved.'); out.set(String(account), (out.get(String(account)) || 0) + n); };
  const control = type => ctx.currencyAccount?.(type, code);
  const sourceTotal = (source, applied, snapshot) => {
    if (!source || currencyOf(source) !== code || !validRate(source.ExchangeRate)) fail('The linked foreign record and its original ExchangeRate are required.');
    const full = homeCents(cents(source.TotalAmt), source.ExchangeRate);
    if (source.HomeTotalAmt !== undefined && cents(source.HomeTotalAmt) !== full) fail('A linked HomeTotalAmt disagrees with its original exchange rate.');
    if (snapshot) {
      const basisProblem = settlementBasisProblem(snapshot, code); if (basisProblem) fail(basisProblem);
      if (currencyOf(snapshot) !== code || snapshot.ExchangeRate !== source.ExchangeRate || snapshot.TotalAmt !== source.TotalAmt || snapshot.HomeTotalAmt !== source.HomeTotalAmt) fail('The retained source currency basis differs from its current record.');
      if (applied === cents(snapshot.Balance) && typeof snapshot.HomeBalance === 'number') return cents(snapshot.HomeBalance);
      if (applied > cents(snapshot.Balance)) fail('The retained source balance is smaller than the settlement.');
    } else if (applied !== cents(source.TotalAmt)) fail('A partial foreign settlement needs its retained pre-send source balance and HomeBalance.');
    return applied === cents(source.TotalAmt) ? full : homeCents(applied, source.ExchangeRate);
  };
  const fx = n => { if (n) add(ctx.exchangeGainLoss, n); };
  if (entity === 'Payment' || entity === 'BillPayment') {
    const customer = entity === 'Payment', side = customer ? -1 : 1;
    let applied = 0, carrying = 0, sourceControl = null;
    for (const line of Array.isArray(record.Line) ? record.Line : []) {
      if (line.LinkedTxn?.length !== 1) fail('A foreign settlement line must identify one source.');
      const link = line.LinkedTxn[0], source = ctx.get(link.TxnType, String(link.TxnId));
      const positive = customer ? link.TxnType === 'Invoice' : link.TxnType === 'Bill';
      if (!(customer ? ['Invoice', 'CreditMemo'] : ['Bill', 'VendorCredit']).includes(link.TxnType)) fail('Unsupported foreign settlement link.');
      if (!source || String(source[customer ? 'CustomerRef' : 'VendorRef']?.value) !== String(record[customer ? 'CustomerRef' : 'VendorRef']?.value)) fail('Foreign settlement party differs from its source.');
      const sourceId = source[customer ? 'ARAccountRef' : 'APAccountRef']?.value;
      if (sourceId && sourceControl && String(sourceId) !== sourceControl) fail('Foreign settlement mixes control accounts.');
      if (sourceId) sourceControl = String(sourceId);
      const signed = cents(line.Amount) * (positive ? 1 : -1);
      applied += signed; carrying += sourceTotal(source, cents(line.Amount), ctx.postingSources?.[link.TxnType + ':' + link.TxnId]) * (positive ? 1 : -1);
    }
    if (applied > amount || applied < 0 || !customer && applied !== amount) fail('Foreign settlement applications exceed its cash amount.');
    carrying += homeCents(amount - applied, rate);
    const selected = record[customer ? 'ARAccountRef' : 'APAccountRef']?.value || sourceControl || control(customer ? 'Accounts Receivable' : 'Accounts Payable');
    if (sourceControl && String(selected) !== sourceControl) fail('Foreign settlement control account differs from its source.');
    const bank = customer ? ((record.LinkedTxn || []).some(link => link.TxnType === 'Deposit') ? ctx.undepositedFunds : record.DepositToAccountRef?.value || ctx.undepositedFunds) : record.PayType === 'CreditCard' ? record.CreditCardPayment?.CCAccountRef?.value : record.CheckPayment?.BankAccountRef?.value;
    add(selected, side * carrying); add(bank, -side * total); fx(side * (total - carrying));
  } else if (entity === 'Deposit') {
    let counterpart = 0;
    for (const line of Array.isArray(record.Line) ? record.Line : []) {
      const value = cents(line.Amount);
      if (line.LinkedTxn?.length) {
        if (line.LinkedTxn.length !== 1) fail('A foreign deposit line needs exactly one receipt.');
        const link = line.LinkedTxn[0], source = ctx.get(link.TxnType, String(link.TxnId));
        if (!['Payment', 'SalesReceipt'].includes(link.TxnType) || !source || value !== cents(source.TotalAmt)) fail('A foreign deposit must clear each receipt in full.');
        const n = sourceTotal(source, value); counterpart += n; add(ctx.undepositedFunds, -n);
      } else { const n = homeCents(value, rate); counterpart += n; add(line.DepositLineDetail?.AccountRef?.value, -n); }
    }
    if (cents(record.TotalAmt) !== (Array.isArray(record.Line) ? record.Line : []).reduce((sum, line) => sum + cents(line.Amount), 0)) fail('Foreign deposit lines do not equal TotalAmt.');
    add(record.DepositToAccountRef?.value, total); fx(counterpart - total);
  } else {
    const original = native(entity, record, { ...ctx, receivables: entity === 'Invoice' ? record.ARAccountRef?.value || control('Accounts Receivable') : ctx.receivables, payables: entity === 'Bill' ? record.APAccountRef?.value || control('Accounts Payable') : ctx.payables });
    const entries = [...original], debits = entries.reduce((sum, [, n]) => sum + Math.max(n, 0), 0), credits = entries.reduce((sum, [, n]) => sum + Math.max(-n, 0), 0);
    if (debits !== amount || credits !== amount) fail('Foreign record lines do not equal its TotalAmt/Amount.');
    for (const [account, n] of [...convertSide(entries, total, rate, 1), ...convertSide(entries, total, rate, -1)]) add(account, n);
  }
  if ([...out.values()].reduce((sum, n) => sum + n, 0) !== 0) fail('Foreign postings do not balance in CAD.');
  return out;
}
module.exports.foreignPostings = foreignPostings;

function preservesCurrency(before, after, payload = {}, entity = null) {
  const expected = currencyOf(before || payload);
  if (!after || currencyOf(after) !== expected) return false;
  if (expected === 'CAD') return true;
  if (!after.CurrencyRef) return false;
  if (['Invoice', 'Bill'].includes(entity) && !exactMoney(after.HomeBalance)) return false;
  const transaction = TXNS.has(entity) || before?.TxnDate !== undefined || after.TxnDate !== undefined;
  if (!transaction) return true;
  if (!validRate(after.ExchangeRate) || before?.ExchangeRate !== undefined && payload.ExchangeRate === undefined && after.ExchangeRate !== before.ExchangeRate) return false;
  const amount = entity === 'Transfer' ? after.Amount : after.TotalAmt;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) return false;
  if ((['Invoice', 'Deposit'].includes(entity) || before?.HomeTotalAmt !== undefined) && typeof after.HomeTotalAmt !== 'number') return false;
  if (after.HomeTotalAmt !== undefined && (typeof after.HomeTotalAmt !== 'number' || !Number.isFinite(after.HomeTotalAmt) || Math.abs(after.HomeTotalAmt * 100 - Math.round(after.HomeTotalAmt * 100)) > 0.00001 || Math.round(after.HomeTotalAmt * 100) !== homeCents(Math.round(amount * 100), after.ExchangeRate))) return false;
  return true;
}
module.exports.preservesCurrency = preservesCurrency;

function settlementBasisProblem(source, code) {
  if (currencyOf(source) !== code || !validRate(source.ExchangeRate) || !exactMoney(source.TotalAmt) || !exactMoney(source.Balance) || !exactMoney(source.HomeBalance) || source.Balance > source.TotalAmt) return 'A foreign settlement source needs its currency, positive ExchangeRate and exact TotalAmt, Balance and HomeBalance before dispatch.';
  if (source.HomeTotalAmt !== undefined && (!exactMoney(source.HomeTotalAmt) || Math.round(source.HomeTotalAmt * 100) !== homeCents(Math.round(source.TotalAmt * 100), source.ExchangeRate))) return 'A source HomeTotalAmt disagrees with its original ExchangeRate before dispatch.';
  return null;
}
module.exports.settlementBasisProblem = settlementBasisProblem;
