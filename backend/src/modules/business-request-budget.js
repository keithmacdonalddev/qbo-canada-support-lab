'use strict';
// Preserve the request reserve for settling existing obligations. This only
// selects a budget lane; normal company, balance, ownership and period guards run.
function isDiscretionaryGeneralWrite(operations) {
  if (!Array.isArray(operations) || !operations.length) return true;
  const priorPayments = new Set();
  const cents = value => typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001 ? Math.round(value * 100) : null;
  for (const op of operations) {
    if (!op || !['create', 'update'].includes(op.op) || !['Payment', 'BillPayment', 'Deposit'].includes(op.entity) || op.op === 'update' && !/^[0-9]{1,30}$/.test(op.id || '')) return true;
    const lines = op.payload?.Line;
    if (!Array.isArray(lines) || !lines.length) return true;
    let applied = 0, debt = 0;
    for (const line of lines) {
      const amount = cents(line?.Amount);
      if (amount === null || amount <= 0 || !Array.isArray(line?.LinkedTxn) || line.LinkedTxn.length !== 1) return true;
      const type = line.LinkedTxn[0]?.TxnType;
      applied += ['CreditMemo', 'VendorCredit'].includes(type) ? -amount : amount;
      if (['Invoice', 'Bill'].includes(type)) debt += amount;
      for (const link of line.LinkedTxn) {
        const types = op.entity === 'Payment' ? ['Invoice', 'CreditMemo'] : op.entity === 'BillPayment' ? ['Bill', 'VendorCredit'] : ['Payment'];
        if (!types.includes(link?.TxnType)) return true;
        if (typeof link.TxnId === 'string' && /^[0-9]{1,30}$/.test(link.TxnId)) continue;
        if (op.entity === 'Deposit' && link.TxnId && Object.keys(link.TxnId).length === 1 && priorPayments.has(link.TxnId.$ref)) continue;
        return true;
      }
    }
    if (op.entity !== 'Deposit' && (!debt || applied < 0 || !Number.isSafeInteger(applied) || cents(op.payload.TotalAmt) !== applied)) return true;
    if (op.entity === 'Payment' && op.op === 'create') priorPayments.add(op.ref);
  }
  return false;
}
module.exports = { isDiscretionaryGeneralWrite };
