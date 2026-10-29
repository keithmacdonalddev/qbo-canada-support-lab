'use strict';
// These are accounting records only. Payment processing uses separate instrument
// data/workflows and is deliberately outside the native business compiler.
const FIELDS = Object.freeze({
 SalesReceipt: ['TxnDate','CurrencyRef','PrivateNote','CustomerRef','GlobalTaxCalculation','DepositToAccountRef','Line'],
 Payment: ['TxnDate','CurrencyRef','PrivateNote','CustomerRef','TotalAmt','Line','DepositToAccountRef','ARAccountRef','ProcessPayment'],
 BillPayment: ['TxnDate','CurrencyRef','PrivateNote','VendorRef','TotalAmt','Line','APAccountRef','PayType','CheckPayment'],
 Purchase: ['TxnDate','CurrencyRef','PrivateNote','PaymentType','AccountRef','EntityRef','GlobalTaxCalculation','Line'],
 VendorCredit: ['TxnDate','CurrencyRef','PrivateNote','VendorRef','APAccountRef','GlobalTaxCalculation','Line'],
});
function accountingOnlyObservation(entity,record) {
 if (!FIELDS[entity]) return true;
 if (!record || ['ProcessPayment','ProcessBillPayment'].some(key=>record[key] !== undefined && record[key] !== false) || ['CreditCardPayment','CreditChargeInfo','CreditChargeResponse'].some(key=>record[key] != null) || record.PaymentType === 'CreditCard') return false;
 // A business expense is paid from the bank as cash: never a card charge or printed cheque.
 if (entity === 'Purchase') return record.PaymentType === 'Cash' && record.Credit !== true;
 return entity !== 'BillPayment' || (record.PayType === 'Check' && record.CheckPayment?.PrintStatus === 'NotSet');
}
function assertAccountingOnlyRequest(entity,payload) {
 if (!FIELDS[entity]) return;
 if (!accountingOnlyObservation(entity,payload) || Object.keys(payload).some(key=>!FIELDS[entity].includes(key)) || (entity==='Payment' && payload.ProcessPayment !== false) || (entity==='BillPayment' && Object.keys(payload.CheckPayment).some(key=>!['BankAccountRef','PrintStatus'].includes(key)))) throw Object.assign(new Error('Business records cannot request electronic payment processing or unsupported payment properties.'),{status:409,code:'BUSINESS_TRANSACTION_UNVERIFIED'});
}
module.exports={assertAccountingOnlyRequest,accountingOnlyObservation};
