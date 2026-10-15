'use strict';
// Legacy fixture batches are planned locally. The governed business calendar is
// the authority for continual history; a batch completion is not calendar proof.
const money = value => Math.round(value * 100) / 100;
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randAmount = (min, max) => money(Math.random() * (max - min) + min);
function pickWeighted(rows) {
  const frequent = Math.max(1, Math.ceil(rows.length * 0.3));
  return rows[randInt(0, Math.random() < 0.7 ? frequent - 1 : rows.length - 1)];
}
const dateOnly = value => new Date(value).toISOString().slice(0, 10);
function later(date, days, asOf) {
  const value = new Date(date + 'T00:00:00Z'); value.setUTCDate(value.getUTCDate() + days);
  const result = dateOnly(value); return result <= asOf ? result : null;
}
async function queryEntities(qbo, entity, nameField, prefix) {
  const result = await qbo.query(`SELECT * FROM ${entity} WHERE ${nameField} LIKE '${prefix}%' MAXRESULTS 1000`);
  return result.QueryResponse?.[entity] || [];
}
async function queryAccounts(qbo, accountType) {
  const result = await qbo.query(`SELECT * FROM Account WHERE AccountType = '${accountType}' MAXRESULTS 10`);
  return result.QueryResponse?.Account || [];
}
async function buildGenerationPlan(config, data) {
  const steps = [], asOf = dateOnly(config.anchorDate), anchor = new Date(asOf + 'T00:00:00Z');
  const names = { invoice: 'Invoice', payment: 'Payment', creditmemo: 'CreditMemo', bill: 'Bill', billpayment: 'BillPayment', vendorcredit: 'VendorCredit' };
  const bank = { value: data.bankAccounts[0].Id };
  let chainIndex = 0;
  function add(entity, payload, amount, party, parent = null, fraction = null) {
    const index = steps.length, type = names[entity];
    steps.push({ entity, payload, state: 'pending',
      ...(fraction === null ? {} : { settlement: { version: 1, sourceIndex: parent, fraction } }),
      transaction: { entity: type, amount, txnDate: payload.TxnDate, customerOrVendor: party, chainIndex,
        linkedTo: fraction === null ? '' : names[steps[parent].entity] + ' #$step:' + parent } });
    return '$step:' + index;
  }
  for (let offset = config.monthsBack - 1; offset >= 0; offset--) {
    const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - offset, 1));
    const lastDay = offset === 0 ? anchor.getUTCDate() : new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const arCount = Math.round(config.txnsPerMonth * config.arWeight);
    for (let i = 0; i < config.txnsPerMonth; i++) {
      chainIndex++;
      const day = new Date(first); day.setUTCDate(randInt(1, lastDay)); const txnDate = dateOnly(day);
      const sales = i < arCount, amount = sales ? randAmount(500, 5000) : randAmount(200, 3000);
      const party = pickWeighted(sales ? data.customers : data.vendors), partyRef = { value: party.Id, name: party.DisplayName };
      const ref = sales ? { CustomerRef: partyRef } : { VendorRef: partyRef };
      const item = sales ? pickWeighted(data.items) : null, expense = sales ? null : pickWeighted(data.expenseAccounts);
      const line = value => sales
        ? { Amount: value, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: item.Id }, UnitPrice: value, Qty: 1 } }
        : { Amount: value, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: expense.Id } } };
      const parent = steps.length;
      const id = add(sales ? 'invoice' : 'bill', { ...ref, TxnDate: txnDate, Line: [line(amount)] }, amount, party.DisplayName);
      const roll = Math.random(), payDate = later(txnDate, sales ? randInt(5, 25) : randInt(10, 30), asOf);
      if (payDate && roll >= 0.15) {
        const fraction = sales && roll < 0.40 ? randInt(30, 80) / 100 : 1;
        const payAmount = money(amount * fraction);
        add(sales ? 'payment' : 'billpayment', { ...ref, TotalAmt: payAmount, TxnDate: payDate,
          ...(sales ? { DepositToAccountRef: bank } : { PayType: 'Check', CheckPayment: { BankAccountRef: bank } }),
          Line: [{ Amount: payAmount, LinkedTxn: [{ TxnId: id, TxnType: sales ? 'Invoice' : 'Bill' }] }] }, payAmount, party.DisplayName, parent, fraction);
      }
      // Standalone credits are left unapplied. Do not invent a transaction link
      // or claim they reduced the originating invoice/bill balance.
      const creditDate = later(txnDate, randInt(5, 20), asOf);
      if (creditDate && Math.random() < 0.10) {
        const credit = randAmount(amount * 0.05, amount * 0.20);
        add(sales ? 'creditmemo' : 'vendorcredit', { ...ref, TxnDate: creditDate, PrivateNote: 'Unapplied legacy test credit', Line: [line(credit)] }, credit, party.DisplayName);
      }
    }
  }
  return steps;
}
module.exports = { buildGenerationPlan, queryEntities, queryAccounts };
