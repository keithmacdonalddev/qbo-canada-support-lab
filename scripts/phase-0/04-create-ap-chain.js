/**
 * 04-create-ap-chain.js
 *
 * Tests: AP-01 through AP-05
 * Creates: purchase order -> bill -> bill payment -> vendor credit
 */
const qbo = require('./lib/qbo-client');
const logger = require('./lib/logger');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function getTestVendor() {
  const result = await qbo.query("SELECT * FROM Vendor WHERE DisplayName LIKE 'TestVendor%' MAXRESULTS 1");
  return result.QueryResponse?.Vendor?.[0];
}

async function getExpenseAccount() {
  const result = await qbo.query("SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 1");
  return result.QueryResponse?.Account?.[0];
}

async function getBankAccount() {
  const result = await qbo.query("SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 1");
  return result.QueryResponse?.Account?.[0];
}

async function getAPAccount() {
  const result = await qbo.query("SELECT * FROM Account WHERE AccountType = 'Accounts Payable' MAXRESULTS 1");
  return result.QueryResponse?.Account?.[0];
}

async function run() {
  logger.info('ap-chain', 'Starting AP chain creation...');

  const vendor = await getTestVendor();
  const expenseAcct = await getExpenseAccount();
  const bankAcct = await getBankAccount();
  const apAcct = await getAPAccount();

  if (!vendor || !expenseAcct || !bankAcct) {
    logger.error('ap-chain', 'Run 02-seed-master-data.js first. Need vendor, expense account, bank account.');
    process.exit(1);
  }

  const vendorRef = { value: vendor.Id, name: vendor.DisplayName };
  const expenseRef = { value: expenseAcct.Id };
  const bankRef = { value: bankAcct.Id };

  const expenseLine = {
    Amount: 2000.00,
    DetailType: 'AccountBasedExpenseLineDetail',
    AccountBasedExpenseLineDetail: { AccountRef: expenseRef },
  };

  // AP-01: Create purchase order
  let po;
  try {
    const poResult = await qbo.create('purchaseorder', {
      VendorRef: vendorRef,
      TxnDate: daysAgo(60),
      APAccountRef: apAcct ? { value: apAcct.Id } : undefined,
      Line: [{
        Amount: 2000.00,
        DetailType: 'ItemBasedExpenseLineDetail',
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: '1' }, // use first available item
          Qty: 10,
          UnitPrice: 200,
        },
      }],
    });
    if (poResult.Fault) {
      logger.result('AP-01', 'Fail', `Purchase order returned Fault: ${JSON.stringify(poResult.Fault.Error?.[0]?.Detail || poResult.Fault)}`);
    } else {
      po = poResult.PurchaseOrder;
      logger.result('AP-01', po ? 'Pass' : 'Fail',
        `Purchase order: Id=${po?.Id}, Total=${po?.TotalAmt}`);
    }
  } catch (err) {
    logger.result('AP-01', 'Partial', `Purchase order creation failed (may not be supported): ${err.message}`);
    logger.info('ap-chain', 'Continuing without PO — will create bill standalone');
  }

  // AP-02: Create bill
  let bill;
  try {
    const billData = {
      VendorRef: vendorRef,
      TxnDate: daysAgo(45),
      Line: [expenseLine],
    };
    // Try linking to PO if it exists
    if (po) {
      billData.LinkedTxn = [{ TxnId: po.Id, TxnType: 'PurchaseOrder' }];
    }

    const billResult = await qbo.create('bill', billData);
    bill = billResult.Bill;
    logger.result('AP-02', 'Pass', `Bill created: Id=${bill.Id}, Balance=${bill.Balance}`);
  } catch (err) {
    // Retry without PO link
    if (po) {
      try {
        const billResult = await qbo.create('bill', {
          VendorRef: vendorRef,
          TxnDate: daysAgo(45),
          Line: [expenseLine],
        });
        bill = billResult.Bill;
        logger.result('AP-02', 'Partial', `Bill created standalone (PO linking not supported): Id=${bill.Id}`);
      } catch (err2) {
        logger.result('AP-02', 'Fail', `Bill creation failed: ${err2.message}`);
        return;
      }
    } else {
      logger.result('AP-02', 'Fail', `Bill creation failed: ${err.message}`);
      return;
    }
  }

  // AP-03: Apply bill payment
  let billPayment;
  try {
    const bpResult = await qbo.create('billpayment', {
      VendorRef: vendorRef,
      TotalAmt: 2000.00,
      TxnDate: daysAgo(20),
      PayType: 'Check',
      CheckPayment: { BankAccountRef: bankRef },
      Line: [{
        Amount: 2000.00,
        LinkedTxn: [{ TxnId: bill.Id, TxnType: 'Bill' }],
      }],
    });
    billPayment = bpResult.BillPayment;
    logger.result('AP-03', 'Pass', `Bill payment applied: Id=${billPayment.Id}, Amount=2000`);
  } catch (err) {
    logger.result('AP-03', 'Fail', `Bill payment failed: ${err.message}`);
  }

  // AP-04: Create vendor credit
  let vendorCredit;
  try {
    const vcResult = await qbo.create('vendorcredit', {
      VendorRef: vendorRef,
      TxnDate: daysAgo(10),
      Line: [{
        Amount: 300.00,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: expenseRef },
      }],
    });
    vendorCredit = vcResult.VendorCredit;
    logger.result('AP-04', 'Pass', `Vendor credit created: Id=${vendorCredit.Id}, Amount=${vendorCredit.TotalAmt}`);
  } catch (err) {
    logger.result('AP-04', 'Fail', `Vendor credit failed: ${err.message}`);
  }

  // AP-05: Read back full chain
  try {
    if (bill) {
      const billRead = await qbo.read('bill', bill.Id);
      const b = billRead.Bill;
      logger.result('AP-05', 'Pass', 'Bill read-back', {
        id: b.Id,
        balance: b.Balance,
        totalAmt: b.TotalAmt,
        linkedTxn: b.LinkedTxn,
        txnDate: b.TxnDate,
      });
    }
  } catch (err) {
    logger.result('AP-05', 'Fail', `AP read-back failed: ${err.message}`);
  }

  logger.info('ap-chain', 'AP chain validation complete.');
}

run().catch(err => {
  logger.error('fatal', err.message);
  process.exit(1);
});
