/**
 * 07-validate-sales-order.js
 *
 * Tests: SO-01 through SO-03
 * Determines whether sales orders and other Advanced-only features
 * are accessible via the API.
 */
const qbo = require('./lib/qbo-client');
const logger = require('./lib/logger');

async function getTestCustomer() {
  const result = await qbo.query("SELECT * FROM Customer WHERE DisplayName LIKE 'TestCust%' MAXRESULTS 1");
  return result.QueryResponse?.Customer?.[0];
}

async function run() {
  logger.info('sales-order', 'Starting sales order validation...');

  const customer = await getTestCustomer();
  if (!customer) {
    logger.error('sales-order', 'Run 02-seed-master-data.js first');
    process.exit(1);
  }

  // SO-01: Attempt to create a sales order
  try {
    const result = await qbo.create('salesreceipt', {
      CustomerRef: { value: customer.Id },
      Line: [{
        Amount: 500,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: '1' },
          UnitPrice: 500,
          Qty: 1,
        },
      }],
    });
    logger.result('SO-01-SalesReceipt', 'Pass', `SalesReceipt created: Id=${result.SalesReceipt?.Id}`);
  } catch (err) {
    logger.result('SO-01-SalesReceipt', 'Fail', `SalesReceipt failed: ${err.message}`);
  }

  // SO-01: Try actual SalesOrder endpoint (may not exist in API)
  try {
    const result = await qbo.query("SELECT * FROM SalesOrder MAXRESULTS 1");
    logger.result('SO-01', 'Pass', `SalesOrder query returned: ${JSON.stringify(result.QueryResponse)}`);
  } catch (err) {
    logger.result('SO-01', 'Partial', `SalesOrder query not supported: ${err.message}`);
  }

  // SO-02: Read fidelity for sales-related entities
  try {
    const estimates = await qbo.query("SELECT * FROM Estimate MAXRESULTS 5");
    const count = estimates.QueryResponse?.Estimate?.length || 0;
    const sample = estimates.QueryResponse?.Estimate?.[0];
    logger.result('SO-02', count > 0 ? 'Pass' : 'Partial',
      `Estimates readable: ${count} found`, sample ? {
        fields: Object.keys(sample),
        hasLinkedTxn: !!sample.LinkedTxn,
        hasLineItems: !!sample.Line,
      } : undefined);
  } catch (err) {
    logger.result('SO-02', 'Fail', `Estimate read failed: ${err.message}`);
  }

  // SO-03: Identify Advanced-only features that might be UI-only
  const advancedEntities = [
    'Transfer',
    'Deposit',
    'JournalEntry',
    'TaxCode',
    'TaxRate',
    'CompanyInfo',
    'Preferences',
  ];

  for (const entity of advancedEntities) {
    try {
      const result = await qbo.query(`SELECT * FROM ${entity} MAXRESULTS 1`);
      const count = Object.values(result.QueryResponse || {})[0]?.length || 0;
      logger.result(`SO-03-${entity}`, 'Pass', `${entity}: queryable, ${count} records`);
    } catch (err) {
      logger.result(`SO-03-${entity}`, 'Fail', `${entity}: not queryable — ${err.message}`);
    }
  }

  logger.info('sales-order', 'Sales order validation complete.');
}

run().catch(err => {
  logger.error('fatal', err.message);
  process.exit(1);
});
