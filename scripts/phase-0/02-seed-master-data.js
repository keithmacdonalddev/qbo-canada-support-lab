/**
 * 02-seed-master-data.js
 *
 * Tests: VOL-01 through VOL-05
 * Creates baseline customers, vendors, items, and accounts.
 * Validates volume feasibility and idempotency design.
 */
const qbo = require('./lib/qbo-client');
const logger = require('./lib/logger');

// --- Data templates ---

function customers(count) {
  const names = [];
  for (let i = 1; i <= count; i++) {
    names.push({
      DisplayName: `TestCust-${String(i).padStart(3, '0')}`,
      CompanyName: `Test Customer ${i} Ltd`,
      PrimaryEmailAddr: { Address: `cust${i}@example.com` },
      BillAddr: { Line1: `${i * 10} Main St`, City: 'Toronto', CountrySubDivisionCode: 'ON', PostalCode: 'M5V 1A1' },
      PrimaryPhone: { FreeFormNumber: `416-555-${String(i).padStart(4, '0')}` },
    });
  }
  return names;
}

function vendors(count) {
  const names = [];
  for (let i = 1; i <= count; i++) {
    names.push({
      DisplayName: `TestVendor-${String(i).padStart(3, '0')}`,
      CompanyName: `Test Vendor ${i} Inc`,
      PrimaryEmailAddr: { Address: `vendor${i}@example.com` },
      PrimaryPhone: { FreeFormNumber: `905-555-${String(i).padStart(4, '0')}` },
    });
  }
  return names;
}

function serviceItems(count) {
  const items = [];
  for (let i = 1; i <= count; i++) {
    items.push({
      Name: `TestSvc-${String(i).padStart(3, '0')}`,
      Type: 'Service',
      IncomeAccountRef: { value: null }, // filled after account query
      Description: `Test service item ${i}`,
      UnitPrice: 50 + (i * 5),
    });
  }
  return items;
}

// --- Helpers ---

async function findExisting(entity, displayNameField) {
  const result = await qbo.query(`SELECT ${displayNameField} FROM ${entity} MAXRESULTS 1000`);
  const records = result.QueryResponse?.[entity] || [];
  return new Set(records.map(r => r[displayNameField]));
}

async function createBatch(entity, items, nameField) {
  const existing = await findExisting(entity, nameField);
  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const item of items) {
    if (existing.has(item[nameField])) {
      skipped++;
      continue;
    }
    try {
      await qbo.create(entity.toLowerCase(), item);
      created++;
    } catch (err) {
      errors.push({ name: item[nameField], error: err.message || String(err) });
    }
  }

  return { created, skipped, errors, total: items.length };
}

// --- Main ---

async function run() {
  logger.info('seed', 'Starting master data seeding...');

  // VOL-04: Query existing accounts to find income account for items
  let incomeAccountId;
  try {
    const accounts = await qbo.query("SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 5");
    const incomeAcct = accounts.QueryResponse?.Account?.[0];
    if (incomeAcct) {
      incomeAccountId = incomeAcct.Id;
      logger.info('seed', `Using income account: ${incomeAcct.Name} (${incomeAcct.Id})`);
    }
  } catch (err) {
    logger.error('seed', `Could not query accounts: ${err.message}`);
  }

  // VOL-04: Check existing chart of accounts
  try {
    const allAccounts = await qbo.query("SELECT * FROM Account MAXRESULTS 200");
    const count = allAccounts.QueryResponse?.Account?.length || 0;
    logger.result('VOL-04', count > 0 ? 'Pass' : 'Fail',
      `Chart of accounts has ${count} accounts (sandbox comes pre-loaded)`);
  } catch (err) {
    logger.result('VOL-04', 'Fail', err.message);
  }

  // VOL-01: Create 50 customers
  logger.info('seed', 'Creating customers...');
  const custResult = await createBatch('Customer', customers(50), 'DisplayName');
  logger.result('VOL-01', custResult.errors.length === 0 ? 'Pass' : 'Partial',
    `Customers: ${custResult.created} created, ${custResult.skipped} skipped, ${custResult.errors.length} errors`,
    custResult.errors.length > 0 ? { errors: custResult.errors } : undefined);

  // VOL-02: Create 30 vendors
  logger.info('seed', 'Creating vendors...');
  const vendResult = await createBatch('Vendor', vendors(30), 'DisplayName');
  logger.result('VOL-02', vendResult.errors.length === 0 ? 'Pass' : 'Partial',
    `Vendors: ${vendResult.created} created, ${vendResult.skipped} skipped, ${vendResult.errors.length} errors`,
    vendResult.errors.length > 0 ? { errors: vendResult.errors } : undefined);

  // VOL-03: Create 50 service items
  logger.info('seed', 'Creating items...');
  const svcItems = serviceItems(50);
  if (incomeAccountId) {
    svcItems.forEach(item => { item.IncomeAccountRef = { value: incomeAccountId }; });
  }
  const itemResult = await createBatch('Item', svcItems, 'Name');
  logger.result('VOL-03', itemResult.errors.length === 0 ? 'Pass' : 'Partial',
    `Items: ${itemResult.created} created, ${itemResult.skipped} skipped, ${itemResult.errors.length} errors`,
    itemResult.errors.length > 0 ? { errors: itemResult.errors } : undefined);

  // VOL-05: Idempotency — run the same creates again
  logger.info('seed', 'Testing idempotency (re-running creates)...');
  const custRetry = await createBatch('Customer', customers(50), 'DisplayName');
  const idempotent = custRetry.created === 0 && custRetry.skipped === 50;
  logger.result('VOL-05', idempotent ? 'Pass' : 'Partial',
    `Idempotency: ${custRetry.skipped} skipped, ${custRetry.created} created on re-run`);

  logger.info('seed', `Done. Total API requests in window: ${qbo.getRequestCount()}`);
}

run().catch(err => {
  logger.error('fatal', err.message);
  process.exit(1);
});
