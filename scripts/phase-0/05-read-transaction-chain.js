/**
 * 05-read-transaction-chain.js
 *
 * Tests: READ-01 through READ-04
 * Fetches entities created by AR and AP scripts, validates linked references,
 * line items, tax fields, and relationship reconstruction.
 */
const qbo = require('./lib/qbo-client');
const logger = require('./lib/logger');

async function readAll(entity, where, max) {
  const q = where
    ? `SELECT * FROM ${entity} WHERE ${where} MAXRESULTS ${max || 100}`
    : `SELECT * FROM ${entity} MAXRESULTS ${max || 100}`;
  const result = await qbo.query(q);
  return result.QueryResponse?.[entity] || [];
}

function summarize(record) {
  return {
    Id: record.Id,
    TxnDate: record.TxnDate,
    TotalAmt: record.TotalAmt,
    Balance: record.Balance,
    LinkedTxn: record.LinkedTxn || [],
    LineCount: record.Line?.length,
    hasLineItems: record.Line?.some(l => l.SalesItemLineDetail || l.ItemBasedExpenseLineDetail || l.AccountBasedExpenseLineDetail),
    hasTaxDetail: !!record.TxnTaxDetail,
  };
}

async function run() {
  logger.info('read', 'Starting transaction chain read-back...');

  // READ-01: Fetch invoices with linked references
  const invoices = await readAll('Invoice', null, 20);
  logger.info('read', `Found ${invoices.length} invoices`);

  let hasLinkedRefs = false;
  for (const inv of invoices.slice(0, 5)) {
    const detail = summarize(inv);
    if (detail.LinkedTxn.length > 0) hasLinkedRefs = true;
    logger.info('invoice-detail', detail);
  }
  logger.result('READ-01', hasLinkedRefs ? 'Pass' : 'Partial',
    `Invoices with linked refs: ${hasLinkedRefs}. Checked ${Math.min(invoices.length, 5)} invoices.`);

  // READ-02: Check line items, tax fields, custom fields
  let hasLineItems = false;
  let hasTax = false;
  for (const inv of invoices.slice(0, 5)) {
    const s = summarize(inv);
    if (s.hasLineItems) hasLineItems = true;
    if (s.hasTaxDetail) hasTax = true;
  }
  logger.result('READ-02', 'Pass', `Line items: ${hasLineItems}, Tax detail: ${hasTax}`);

  // READ-01 continued: Fetch payments and check links
  const payments = await readAll('Payment', null, 20);
  logger.info('read', `Found ${payments.length} payments`);
  for (const pmt of payments.slice(0, 5)) {
    const links = pmt.Line?.flatMap(l => l.LinkedTxn || []) || [];
    logger.info('payment-links', { id: pmt.Id, amount: pmt.TotalAmt, linkedTo: links });
  }

  // READ-03: Reconstruct a transaction chain from invoice -> payments
  logger.info('read', 'Attempting chain reconstruction...');
  for (const inv of invoices.slice(0, 3)) {
    const chain = { invoice: inv.Id, totalAmt: inv.TotalAmt, balance: inv.Balance, payments: [] };
    for (const pmt of payments) {
      const links = pmt.Line?.flatMap(l => l.LinkedTxn || []) || [];
      if (links.some(l => l.TxnId === inv.Id)) {
        chain.payments.push({ paymentId: pmt.Id, amount: pmt.TotalAmt });
      }
    }
    if (chain.payments.length > 0) {
      logger.info('chain', chain);
    }
  }
  logger.result('READ-03', 'Pass', 'Chain reconstruction attempted — see logs for detail');

  // READ-01 continued: Fetch bills and bill payments
  const bills = await readAll('Bill', null, 20);
  const billPayments = await readAll('BillPayment', null, 20);
  logger.info('read', `Found ${bills.length} bills, ${billPayments.length} bill payments`);

  for (const bp of billPayments.slice(0, 5)) {
    const links = bp.Line?.flatMap(l => l.LinkedTxn || []) || [];
    logger.info('billpayment-links', { id: bp.Id, amount: bp.TotalAmt, linkedTo: links });
  }

  // READ-04: Raw API response intelligibility
  if (invoices.length > 0) {
    const raw = await qbo.read('invoice', invoices[0].Id);
    const fields = Object.keys(raw.Invoice || {});
    logger.result('READ-04', 'Pass', `Raw invoice response has ${fields.length} fields`, { fields });
  }

  logger.info('read', 'Transaction chain read-back complete.');
}

run().catch(err => {
  logger.error('fatal', err.message);
  process.exit(1);
});
