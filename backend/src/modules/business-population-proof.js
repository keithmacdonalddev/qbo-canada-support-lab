'use strict';
const { hash, canonical } = require('./business-calendar');
const { denied } = require('./qbo-write-contract');
function assertUnreceivedParent(parent, now) {
  require('./business-readback').verifyPopulationFinancialParent(parent,now);
  const record = parent.record, empty = links => links === undefined || (Array.isArray(links) && !links.length);
  if (parent.entity !== 'PurchaseOrder' || record.POStatus !== 'Open' || !empty(record.LinkedTxn) || JSON.parse(parent.financialProof.sourceJson).children.length || !Array.isArray(record.Line) || !record.Line.length || record.Line.some(line => !empty(line.LinkedTxn) || ![undefined,0].includes(line.Received) || line.DetailType !== 'ItemBasedExpenseLineDetail')) throw denied('The exact purchase order is not wholly unreceived.');
  return true;
}
async function readPopulationDeposits(client) {
  const records = [], ids = new Set(), payments = new Set(); let bytes = 0;
  for (let start = 1; start <= 10001; start += 1000) {
    const body = await client.query('SELECT * FROM Deposit ORDERBY Id ASC STARTPOSITION ' + start + ' MAXRESULTS 1000'), page = body?.QueryResponse, rows = page?.Deposit || [];
    if (!page || !Array.isArray(rows) || rows.length > 1000 || (rows.length && page.startPosition !== start) || (page.maxResults !== undefined && page.maxResults !== rows.length)) throw denied('Deposit availability pagination is incomplete.');
    for (const record of rows) {
      bytes += Buffer.byteLength(canonical(record));
      if (!/^\d{1,30}$/.test(record?.Id || '') || typeof record.SyncToken !== 'string' || record.sparse === true || ids.has(record.Id) || records.length >= 10000 || bytes > 32000000 || !Array.isArray(record.Line) || !record.Line.length) throw denied('Deposit availability is incomplete or exceeds its bound.');
      ids.add(record.Id);
      for (const line of record.Line) if (!line || typeof line.Amount !== 'number' || !Number.isFinite(line.Amount) || (!line.LinkedTxn?.length && !/^\d{1,30}$/.test(line.DepositLineDetail?.AccountRef?.value || ''))) throw denied('A deposit line lacks complete source information.');
      for (const links of [record.LinkedTxn, ...record.Line.map(line => line.LinkedTxn)].filter(value => value !== undefined)) {
        if (!Array.isArray(links) || links.some(link => !/^\d{1,30}$/.test(link?.TxnId || '') || typeof link.TxnType !== 'string')) throw denied('Deposit source links are incomplete.');
        for (const link of links) if (link.TxnType === 'Payment') payments.add(link.TxnId);
      }
      records.push({ id: record.Id, hash: hash(record) });
    }
    if (rows.length < 1000) { if (page.totalCount !== undefined && page.totalCount !== records.length) throw denied('Deposit availability count differs.'); return { hash: hash(records), payments }; }
  }
  throw denied('Deposit availability exceeds its bounded scan.');
}
module.exports = { assertUnreceivedParent, readPopulationDeposits };
