'use strict';
// Shared account-native routing and integer money. No storage, clocks or QBO calls.
const C = require('./bank-settlement-contract');
const ref = value => value?.value === undefined ? null : String(value.value);
function nativeAmount(record, accountCurrency, amount, sign = 1, { entity, homeCurrency } = {}) {
  if (!accountCurrency || (record.CurrencyRef?.value !== accountCurrency && !(entity === 'TaxPayment' && !record.CurrencyRef?.value && accountCurrency === homeCurrency))) return null;
  try { return C.integer(C.minor(amount) * sign); } catch { return null; }
}
function settlementLegs(entity, r) {
  const leg = (accountId, amount, sign, kind) => ({ accountId, amount, sign, kind });
  if (['Payment','SalesReceipt'].includes(entity)) return [leg(ref(r.DepositToAccountRef),r.TotalAmt,1,'direct-receipt')];
  if (['Deposit','Invoice','RefundReceipt'].includes(entity)) {
    if (entity === 'Invoice' && (r.Deposit === undefined || r.Deposit === 0)) return [];
    return [leg(ref(r.DepositToAccountRef),entity === 'Invoice' ? r.Deposit : r.TotalAmt,entity === 'RefundReceipt' ? -1 : 1,entity === 'Deposit' ? 'deposit' : entity === 'Invoice' ? 'invoice-deposit' : 'refund')];
  }
  if (entity === 'Purchase') return [leg(ref(r.AccountRef),r.TotalAmt,r.Credit === true ? 1 : -1,r.Credit === true ? 'card-credit' : 'purchase')];
  if (entity === 'BillPayment') return [leg(ref(r.CheckPayment?.BankAccountRef) || ref(r.CreditCardPayment?.CCAccountRef),r.TotalAmt,-1,'bill-payment')];
  if (['Transfer','CreditCardPayment'].includes(entity)) return [leg(ref(entity === 'Transfer' ? r.FromAccountRef : r.BankAccountRef),r.Amount,-1,'transfer-out'),leg(ref(entity === 'Transfer' ? r.ToAccountRef : r.CreditCardAccountRef),r.Amount,1,'transfer-in')];
  if (entity === 'TaxPayment') return [leg(ref(r.PaymentAccountRef),r.PaymentAmount,-1,'tax-payment')];
  return [];
}
// Legs that move money at a bank. A transfer to or from physical cash keeps only
// its bank leg; the instruction names the cash account it skipped.
function bankLegs(legs, cashCounterpartAccountId, accountId) {
  if (!cashCounterpartAccountId) return legs;
  if (cashCounterpartAccountId === accountId || !legs.some(l => l.accountId === cashCounterpartAccountId)) return null;
  return legs.filter(l => l.accountId !== cashCounterpartAccountId);
}
module.exports = { nativeAmount, settlementLegs, bankLegs };
