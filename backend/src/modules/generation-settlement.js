'use strict';
const cents = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
const fail = message => { throw new Error(message); };
// Read the exact batch-created source before computing settlement. A quoted
// subtotal is not a payable amount: QuickBooks can add sales/purchase tax.
async function prepareSettlement(step, steps, qbo) {
  const sourceType = step.entity === 'payment' ? 'Invoice' : step.entity === 'billpayment' ? 'Bill' : null;
  if (!sourceType) return null;
  const links = step.payload?.Line?.[0]?.LinkedTxn;
  const match = typeof links?.[0]?.TxnId === 'string' && /^\$step:(\d+)$/.exec(links[0].TxnId);
  const index = step.settlement?.sourceIndex ?? (match ? Number(match[1]) : null);
  const bank = step.entity === 'payment' ? step.payload.DepositToAccountRef?.value : step.payload.CheckPayment?.BankAccountRef?.value;
  if (!bank) fail('The saved settlement has no explicit bank destination. Review this older plan before continuing.');
  const source = Number.isSafeInteger(index) ? steps[index] : null;
  if (!match || index !== Number(match[1]) || !source || source.entity !== sourceType.toLowerCase() || source.state !== 'succeeded' || !source.receipt?.Id || step.payload.Line.length !== 1 || links.length !== 1) fail('Settlement needs one confirmed batch-created source.');
  const plannedBase = cents(source.transaction?.amount), plannedPayment = cents(step.transaction?.amount);
  const fraction = step.settlement?.fraction ?? (plannedBase > 0 ? plannedPayment / plannedBase : NaN);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) fail('The saved settlement proportion is invalid.');
  const body = await qbo.read(sourceType.toLowerCase(), source.receipt.Id), record = body?.[sourceType];
  const partyKey = sourceType === 'Invoice' ? 'CustomerRef' : 'VendorRef';
  const party = step.payload[partyKey]?.value || source.payload[partyKey]?.value;
  const total = cents(record?.TotalAmt), balance = cents(record?.Balance);
  if (!record || String(record.Id) !== String(source.receipt.Id) || !party || !/^\d+$/.test(String(record.SyncToken ?? '')) || String(record[partyKey]?.value) !== String(party) || record.TxnDate !== source.payload.TxnDate || total === null || total <= 0 || balance === null || balance <= 0 || balance > total) fail('The source amount, party, date or open balance could not be verified. Nothing was paid.');
  if (cents(source.receipt.TotalAmt) !== total || source.receipt.SyncToken === undefined || String(source.receipt.SyncToken) !== String(record.SyncToken)) fail('The batch source changed after it was created. Review it before paying.');
  const amount = Math.min(balance, Math.round(total * fraction));
  if (amount <= 0) fail('The source has no payable amount.');
  return { version: 1, sourceIndex: index, sourceId: String(record.Id), sourceType, total: total / 100, balance: balance / 100, syncToken: String(record.SyncToken), fraction, amount: amount / 100 };
}
async function verifySettlement(settlement, qbo, saved) {
  const payment = (await qbo.read(saved.entity.toLowerCase(), saved.id))?.[saved.entity], payload = saved.payload;
  const key = saved.entity === 'Payment' ? 'CustomerRef' : 'VendorRef';
  const bank = value => saved.entity === 'Payment' ? value?.DepositToAccountRef?.value : value?.CheckPayment?.BankAccountRef?.value;
  const links = payment?.Line?.[0]?.LinkedTxn;
  if (!payload || !payment || String(payment.Id) !== saved.id || cents(payment.TotalAmt) !== cents(settlement.amount) || payment.TxnDate !== payload.TxnDate || String(payment[key]?.value) !== String(payload[key]?.value) || !bank(payload) || String(bank(payment)) !== String(bank(payload)) || !Array.isArray(payment.Line) || payment.Line.length !== 1 || cents(payment.Line[0].Amount) !== cents(settlement.amount) || !Array.isArray(links) || links.length !== 1 || String(links[0].TxnId) !== settlement.sourceId || links[0].TxnType !== settlement.sourceType || (payment.UnappliedAmt !== undefined && cents(payment.UnappliedAmt) !== 0)) fail('The saved payment amount, party, date, application or bank destination is not verified. It will not be recreated.');
  const record = (await qbo.read(settlement.sourceType.toLowerCase(), settlement.sourceId))?.[settlement.sourceType];
  const expected = cents(settlement.balance) - cents(settlement.amount);
  if (!record || String(record.Id) !== settlement.sourceId || cents(record.TotalAmt) !== cents(settlement.total) || cents(record.Balance) !== expected) fail('QuickBooks did not confirm the expected remaining balance. The saved payment will not be recreated; inspect the linked source.');
  return { version: 1, paymentId: saved.id, sourceId: settlement.sourceId, remainingBalance: expected / 100, syncToken: String(record.SyncToken) };
}
module.exports = { prepareSettlement, verifySettlement };
