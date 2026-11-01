'use strict';
const crypto = require('node:crypto');
const C = require('./bank-settlement-contract');
const CSV_PROFILE = Object.freeze({ id:'ca-three-column-v1', columns:['Date','Description','Amount'],
  dateFormat:'dd/mm/yyyy', encoding:'UTF-8', newline:'CRLF', maxRows:999, maxBytes:340000,
  bankSigns:'inflows positive; outflows negative', cardSigns:'charges negative; payments and credits positive',
  nativePreviewRequired:true });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function formatMoney(value) {
  const n = BigInt(C.integer(value));
  const abs = n < 0n ? -n : n;
  return (n < 0n ? '-' : '') + (abs / 100n) + '.' + String(abs % 100n).padStart(2,'0');
}
function formatDate(value) { return C.date(value).split('-').reverse().join('/'); }
function eventDate(event) { return C.date(event.actualPostingDate || event.expectedPostingDate); }
function description(event) {
  // Keep digits, identifiers and detailed advice in the sidecar; feed descriptions
  // are English, ASCII and cannot become spreadsheet formulas or multiline rows.
  const labels = { Payment:'Customer payment', SalesReceipt:'Sales receipt', Deposit:'Bank deposit',
    Invoice:'Invoice deposit', Purchase:'Purchase', BillPayment:'Supplier payment', Transfer:'Bank transfer',
    CreditCardPayment:'Card payment', RefundReceipt:'Customer refund', TaxPayment:'Tax payment',
    JournalEntry:'Account movement', TaxAdjustment:'Tax settlement' };
  const label = event.description || labels[event.source?.entity] || event.kind || 'Bank movement';
  return String(label).normalize('NFKD').replace(/[^A-Za-z -]/g,' ').replace(/\s+/g,' ').trim().slice(0,100) || 'Bank movement';
}
function generateBankFeedCsv(events, options) {
  const {scope,accountId,accountCurrency} = options;
  C.validateScope(scope);
  if (!accountId || !/^[A-Z]{3}$/.test(accountCurrency || '')) throw new TypeError('CSV account and currency are required.');
  const maxRows = options.maxRows ?? CSV_PROFILE.maxRows, maxBytes = options.maxBytes ?? CSV_PROFILE.maxBytes;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > CSV_PROFILE.maxRows || !Number.isInteger(maxBytes) || maxBytes < 100 || maxBytes > CSV_PROFILE.maxBytes) throw new TypeError('CSV limits must stay within the Canadian profile.');
  const seen = new Set();
  const sorted = [...events].map(event => {
    C.validateEvent(event); C.assertScope(event.scope,scope);
    if (event.accountId !== accountId || event.accountCurrency !== accountCurrency || event.status !== 'resolved' || event.supersededBy || event.resolution.action === 'Exclude' || seen.has(event.eventId)) throw new TypeError('CSV requires unique current resolved events in one account/currency.');
    seen.add(event.eventId); eventDate(event); return event;
  }).sort((a,b) => eventDate(a).localeCompare(eventDate(b)) || a.eventId.localeCompare(b.eventId));
  const files = [], header = 'Date,Description,Amount\r\n';
  let lines = [], rows = [], size = Buffer.byteLength(header);
  function flush() {
    if (!rows.length) return;
    const bytes = Buffer.from(header + lines.join(''),'utf8');
    files.push({fileName:'feed-' + String(files.length+1).padStart(3,'0') + '.csv',bytes,sha256:sha256(bytes),rowCount:rows.length,rows});
    lines = []; rows = []; size = Buffer.byteLength(header);
  }
  for (const event of sorted) {
    const date = eventDate(event), desc = description(event), amount = formatMoney(event.amountMinor);
    const line = [formatDate(date),desc,amount].join(',') + '\r\n', length = Buffer.byteLength(line);
    if (Buffer.byteLength(header) + length > maxBytes) throw new TypeError('One CSV row exceeds the byte limit.');
    if (rows.length >= maxRows || size + length > maxBytes) flush();
    lines.push(line); size += length;
    rows.push({eventId:event.eventId,eventRevision:event.revision,rowNumber:rows.length+1,date,description:desc,amountMinor:event.amountMinor});
  }
  flush();
  return {profile:{...CSV_PROFILE,maxRows,maxBytes},files};
}
module.exports = { CSV_PROFILE, formatMoney, formatDate, eventDate, description, sha256, generateBankFeedCsv };
