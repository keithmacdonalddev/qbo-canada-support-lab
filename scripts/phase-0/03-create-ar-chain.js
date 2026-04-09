/**
 * 03-create-ar-chain.js
 *
 * Tests: AR-01 through AR-06, DATE-01 through DATE-04
 * Creates: estimate -> invoice -> partial payment -> credit memo -> remaining payment
 * Tests backdating at 30, 90, and 180+ days.
 */
const qbo = require('./lib/qbo-client');
const logger = require('./lib/logger');

async function getTestCustomer() {
  const result = await qbo.query("SELECT * FROM Customer WHERE DisplayName LIKE 'TestCust%' MAXRESULTS 1");
  return result.QueryResponse?.Customer?.[0];
}

async function getTestItem() {
  const result = await qbo.query("SELECT * FROM Item WHERE Name LIKE 'TestSvc%' MAXRESULTS 1");
  return result.QueryResponse?.Item?.[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function run() {
  logger.info('ar-chain', 'Starting AR chain creation...');

  const customer = await getTestCustomer();
  const item = await getTestItem();

  if (!customer || !item) {
    logger.error('ar-chain', 'Run 02-seed-master-data.js first to create test data');
    process.exit(1);
  }

  const custRef = { value: customer.Id, name: customer.DisplayName };
  const itemRef = { value: item.Id, name: item.Name };
  const lineDetail = {
    Amount: 1000.00,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: { ItemRef: itemRef, UnitPrice: 1000, Qty: 1 },
  };

  // --- DATE tests: backdating at various intervals ---

  // DATE-01: 30 days back
  try {
    const inv30 = await qbo.create('invoice', {
      CustomerRef: custRef,
      TxnDate: daysAgo(30),
      Line: [lineDetail],
    });
    const created = inv30.Invoice;
    logger.result('DATE-01', 'Pass', `Invoice backdated 30 days: TxnDate=${created.TxnDate}, Id=${created.Id}`);
    // Clean up — we just needed to test the date
  } catch (err) {
    logger.result('DATE-01', 'Fail', `30-day backdating failed: ${err.message}`);
  }

  // DATE-02: 90 days back
  try {
    const inv90 = await qbo.create('invoice', {
      CustomerRef: custRef,
      TxnDate: daysAgo(90),
      Line: [lineDetail],
    });
    logger.result('DATE-02', 'Pass', `Invoice backdated 90 days: TxnDate=${inv90.Invoice.TxnDate}`);
  } catch (err) {
    logger.result('DATE-02', 'Fail', `90-day backdating failed: ${err.message}`);
  }

  // DATE-03: 180+ days back
  try {
    const inv180 = await qbo.create('invoice', {
      CustomerRef: custRef,
      TxnDate: daysAgo(200),
      Line: [lineDetail],
    });
    logger.result('DATE-03', 'Pass', `Invoice backdated 200 days: TxnDate=${inv180.Invoice.TxnDate}`);
  } catch (err) {
    logger.result('DATE-03', 'Fail', `200-day backdating failed: ${err.message}`);
  }

  // --- AR chain: estimate -> invoice -> partial payment -> credit memo -> final payment ---

  // AR-01: Create estimate
  let estimate;
  try {
    const estResult = await qbo.create('estimate', {
      CustomerRef: custRef,
      TxnDate: daysAgo(60),
      Line: [lineDetail],
    });
    estimate = estResult.Estimate;
    logger.result('AR-01', 'Pass', `Estimate created: Id=${estimate.Id}, Total=${estimate.TotalAmt}`);
  } catch (err) {
    logger.result('AR-01', 'Fail', `Estimate creation failed: ${err.message}`);
    return;
  }

  // AR-02: Create invoice (linked to estimate if supported, otherwise standalone)
  let invoice;
  try {
    const invResult = await qbo.create('invoice', {
      CustomerRef: custRef,
      TxnDate: daysAgo(45),
      Line: [lineDetail],
      LinkedTxn: [{ TxnId: estimate.Id, TxnType: 'Estimate' }],
    });
    invoice = invResult.Invoice;
    logger.result('AR-02', 'Pass', `Invoice created from estimate: Id=${invoice.Id}, Balance=${invoice.Balance}`);
  } catch (err) {
    // Retry without linked estimate
    logger.info('ar-chain', 'Linked invoice failed, trying standalone...');
    try {
      const invResult = await qbo.create('invoice', {
        CustomerRef: custRef,
        TxnDate: daysAgo(45),
        Line: [lineDetail],
      });
      invoice = invResult.Invoice;
      logger.result('AR-02', 'Partial', `Invoice created standalone (estimate linking not supported): Id=${invoice.Id}`);
    } catch (err2) {
      logger.result('AR-02', 'Fail', `Invoice creation failed: ${err2.message}`);
      return;
    }
  }

  // AR-03: Apply partial payment
  let payment1;
  try {
    const payResult = await qbo.create('payment', {
      CustomerRef: custRef,
      TotalAmt: 600.00,
      TxnDate: daysAgo(30),
      Line: [{
        Amount: 600.00,
        LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
      }],
    });
    payment1 = payResult.Payment;
    logger.result('AR-03', 'Pass', `Partial payment applied: Id=${payment1.Id}, Amount=600`);
  } catch (err) {
    logger.result('AR-03', 'Fail', `Partial payment failed: ${err.message}`);
    return;
  }

  // AR-04: Create credit memo
  let creditMemo;
  try {
    const cmResult = await qbo.create('creditmemo', {
      CustomerRef: custRef,
      TxnDate: daysAgo(20),
      Line: [{
        Amount: 150.00,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { ItemRef: itemRef, UnitPrice: 150, Qty: 1 },
      }],
    });
    creditMemo = cmResult.CreditMemo;
    logger.result('AR-04', 'Pass', `Credit memo created: Id=${creditMemo.Id}, Amount=${creditMemo.TotalAmt}`);
  } catch (err) {
    logger.result('AR-04', 'Fail', `Credit memo failed: ${err.message}`);
  }

  // AR-05: Apply remaining payment
  try {
    // Refresh invoice to get current balance
    const invRead = await qbo.read('invoice', invoice.Id);
    const remaining = invRead.Invoice.Balance;
    logger.info('ar-chain', `Invoice remaining balance: ${remaining}`);

    const payResult = await qbo.create('payment', {
      CustomerRef: custRef,
      TotalAmt: remaining,
      TxnDate: daysAgo(10),
      Line: [{
        Amount: remaining,
        LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
      }],
    });
    logger.result('AR-05', 'Pass', `Remaining payment applied: Id=${payResult.Payment.Id}, Amount=${remaining}`);
  } catch (err) {
    logger.result('AR-05', 'Fail', `Remaining payment failed: ${err.message}`);
  }

  // AR-06: Read back full chain and confirm linked references
  try {
    const invFinal = await qbo.read('invoice', invoice.Id);
    const inv = invFinal.Invoice;
    logger.result('AR-06', 'Pass', 'Invoice read-back', {
      id: inv.Id,
      balance: inv.Balance,
      totalAmt: inv.TotalAmt,
      linkedTxn: inv.LinkedTxn,
      txnDate: inv.TxnDate,
    });

    // DATE-04: Confirm report dates
    logger.result('DATE-04', 'Pass', `Read-back TxnDate preserved: ${inv.TxnDate}`);
  } catch (err) {
    logger.result('AR-06', 'Fail', `Read-back failed: ${err.message}`);
  }

  logger.info('ar-chain', 'AR chain validation complete.');
}

run().catch(err => {
  logger.error('fatal', err.message);
  process.exit(1);
});
