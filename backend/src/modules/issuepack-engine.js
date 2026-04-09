/**
 * Issue Pack Engine
 *
 * Each pack is a function that takes a QBO client and loaded entity data,
 * and returns { createdEntities, log }.
 */

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- Pack 1: AR Mismatch ---

async function executeArMismatch(qbo, { customers, items }) {
  const log = [];
  const createdEntities = [];

  const customer = pickRandom(customers);
  const item = pickRandom(items);
  const custRef = { value: customer.Id, name: customer.DisplayName };
  const itemRef = { value: item.Id, name: item.Name };
  const amount = 1500.00;

  // Step 1: Create invoice
  log.push({ step: 1, action: 'Create invoice', outcome: 'pending', detail: '', timestamp: new Date() });
  const invResult = await qbo.create('invoice', {
    CustomerRef: custRef,
    TxnDate: daysAgo(15),
    Line: [{
      Amount: amount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: itemRef, UnitPrice: amount, Qty: 1 },
    }],
  });
  const invoice = invResult.Invoice;
  createdEntities.push({ entity: 'Invoice', qboId: invoice.Id, step: 1 });
  log[0] = { ...log[0], outcome: 'success', detail: `Invoice #${invoice.DocNumber || invoice.Id} for $${amount}` };

  // Step 2: Create payment with wrong amount (off by $0.01)
  const mismatchAmount = amount + 0.01;
  log.push({ step: 2, action: 'Create mismatched payment', outcome: 'pending', detail: '', timestamp: new Date() });
  const payResult = await qbo.create('payment', {
    CustomerRef: custRef,
    TotalAmt: mismatchAmount,
    TxnDate: daysAgo(5),
    Line: [{
      Amount: mismatchAmount,
      LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
    }],
  });
  const payment = payResult.Payment;
  createdEntities.push({ entity: 'Payment', qboId: payment.Id, step: 2 });
  log[1] = { ...log[1], outcome: 'success', detail: `Payment $${mismatchAmount} applied to Invoice $${amount} — $0.01 overpayment` };

  return { createdEntities, log };
}

// --- Pack 2: Duplicate Payment ---

async function executeDuplicatePayment(qbo, { vendors, expenseAccounts, bankAccounts }) {
  const log = [];
  const createdEntities = [];

  const vendor = pickRandom(vendors);
  const expenseAcct = pickRandom(expenseAccounts);
  const bankAcct = bankAccounts[0];
  const vendorRef = { value: vendor.Id, name: vendor.DisplayName };
  const amount = 2000.00;

  // Step 1: Create bill
  log.push({ step: 1, action: 'Create bill', outcome: 'pending', detail: '', timestamp: new Date() });
  const billResult = await qbo.create('bill', {
    VendorRef: vendorRef,
    TxnDate: daysAgo(30),
    Line: [{
      Amount: amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAcct.Id } },
    }],
  });
  const bill = billResult.Bill;
  createdEntities.push({ entity: 'Bill', qboId: bill.Id, step: 1 });
  log[0] = { ...log[0], outcome: 'success', detail: `Bill #${bill.DocNumber || bill.Id} for $${amount}` };

  // Step 2: Pay via bill payment
  log.push({ step: 2, action: 'Create bill payment', outcome: 'pending', detail: '', timestamp: new Date() });
  const bpResult = await qbo.create('billpayment', {
    VendorRef: vendorRef,
    TotalAmt: amount,
    TxnDate: daysAgo(15),
    PayType: 'Check',
    CheckPayment: { BankAccountRef: { value: bankAcct.Id } },
    Line: [{
      Amount: amount,
      LinkedTxn: [{ TxnId: bill.Id, TxnType: 'Bill' }],
    }],
  });
  const bp = bpResult.BillPayment;
  createdEntities.push({ entity: 'BillPayment', qboId: bp.Id, step: 2 });
  log[1] = { ...log[1], outcome: 'success', detail: `Bill payment $${amount}` };

  // Step 3: Duplicate payment via direct expense (check)
  log.push({ step: 3, action: 'Create duplicate expense payment', outcome: 'pending', detail: '', timestamp: new Date() });
  const purchaseResult = await qbo.create('purchase', {
    AccountRef: { value: bankAcct.Id },
    PaymentType: 'Check',
    TxnDate: daysAgo(14),
    EntityRef: { value: vendor.Id, type: 'Vendor' },
    Line: [{
      Amount: amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAcct.Id } },
    }],
  });
  const purchase = purchaseResult.Purchase;
  createdEntities.push({ entity: 'Purchase', qboId: purchase.Id, step: 3 });
  log[2] = { ...log[2], outcome: 'success', detail: `Duplicate check payment $${amount} to same vendor` };

  return { createdEntities, log };
}

// --- Pack 3: Tax Code Inconsistency ---

async function discoverTaxCodes(qbo) {
  const result = await qbo.query("SELECT * FROM TaxCode MAXRESULTS 50");
  const codes = result.QueryResponse?.TaxCode || [];
  const taxable = codes.find((c) => c.Active && c.Name !== 'NON' && c.Name !== 'Exempt' && c.Name !== 'Out of scope');
  const exempt = codes.find((c) => c.Active && (c.Name === 'NON' || c.Name === 'Exempt' || c.Name === 'Tax exempt'));
  return {
    taxableCode: taxable?.Id || taxable?.Name || 'TAX',
    taxableName: taxable?.Name || 'TAX',
    exemptCode: exempt?.Id || exempt?.Name || 'NON',
    exemptName: exempt?.Name || 'NON',
  };
}

async function executeTaxCodeInconsistency(qbo, { customers, items }) {
  const log = [];
  const createdEntities = [];

  const customer = pickRandom(customers);
  const item = pickRandom(items);
  const custRef = { value: customer.Id, name: customer.DisplayName };
  const itemRef = { value: item.Id, name: item.Name };

  // Discover valid tax codes for this company
  const taxCodes = await discoverTaxCodes(qbo);

  // Step 1: Create invoice with taxable line
  log.push({ step: 1, action: 'Create invoice with taxable items', outcome: 'pending', detail: '', timestamp: new Date() });
  const inv1Result = await qbo.create('invoice', {
    CustomerRef: custRef,
    TxnDate: daysAgo(20),
    Line: [{
      Amount: 800.00,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: itemRef,
        UnitPrice: 800,
        Qty: 1,
        TaxCodeRef: { value: taxCodes.taxableCode },
      },
    }],
  });
  const inv1 = inv1Result.Invoice;
  createdEntities.push({ entity: 'Invoice', qboId: inv1.Id, step: 1 });
  log[0] = { ...log[0], outcome: 'success', detail: `Invoice #${inv1.DocNumber || inv1.Id} with ${taxCodes.taxableName} tax code` };

  // Step 2: Create similar invoice with exempt line (same customer, same item)
  log.push({ step: 2, action: 'Create invoice with exempt items', outcome: 'pending', detail: '', timestamp: new Date() });
  const inv2Result = await qbo.create('invoice', {
    CustomerRef: custRef,
    TxnDate: daysAgo(10),
    Line: [{
      Amount: 800.00,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: itemRef,
        UnitPrice: 800,
        Qty: 1,
        TaxCodeRef: { value: taxCodes.exemptCode },
      },
    }],
  });
  const inv2 = inv2Result.Invoice;
  createdEntities.push({ entity: 'Invoice', qboId: inv2.Id, step: 2 });
  log[1] = { ...log[1], outcome: 'success', detail: `Invoice #${inv2.DocNumber || inv2.Id} with ${taxCodes.exemptName} (exempt) code — same customer + item` };

  return { createdEntities, log };
}

// --- Pack 4: Unapplied Credit ---

async function executeUnappliedCredit(qbo, { customers, items }) {
  const log = [];
  const createdEntities = [];

  const customer = pickRandom(customers);
  const item = pickRandom(items);
  const custRef = { value: customer.Id, name: customer.DisplayName };
  const itemRef = { value: item.Id, name: item.Name };

  // Step 1: Create a credit memo NOT linked to any invoice
  log.push({ step: 1, action: 'Create unapplied credit memo', outcome: 'pending', detail: '', timestamp: new Date() });
  const cmResult = await qbo.create('creditmemo', {
    CustomerRef: custRef,
    TxnDate: daysAgo(12),
    Line: [{
      Amount: 350.00,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: itemRef, UnitPrice: 350, Qty: 1 },
    }],
  });
  const cm = cmResult.CreditMemo;
  createdEntities.push({ entity: 'CreditMemo', qboId: cm.Id, step: 1 });
  log[0] = { ...log[0], outcome: 'success', detail: `Credit memo #${cm.DocNumber || cm.Id} for $350 — not linked to any invoice` };

  // Step 2: Create an outstanding invoice (to make it obvious the credit should have been applied)
  log.push({ step: 2, action: 'Create outstanding invoice', outcome: 'pending', detail: '', timestamp: new Date() });
  const invResult = await qbo.create('invoice', {
    CustomerRef: custRef,
    TxnDate: daysAgo(15),
    Line: [{
      Amount: 500.00,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: itemRef, UnitPrice: 500, Qty: 1 },
    }],
  });
  const inv = invResult.Invoice;
  createdEntities.push({ entity: 'Invoice', qboId: inv.Id, step: 2 });
  log[1] = { ...log[1], outcome: 'success', detail: `Outstanding invoice #${inv.DocNumber || inv.Id} for $500 — credit memo should apply here` };

  return { createdEntities, log };
}

// --- Pack 5: Orphaned Payment ---

async function executeOrphanedPayment(qbo, { customers }) {
  const log = [];
  const createdEntities = [];

  const customer = pickRandom(customers);
  const custRef = { value: customer.Id, name: customer.DisplayName };

  // Step 1: Create a payment with no linked invoice
  log.push({ step: 1, action: 'Create orphaned payment', outcome: 'pending', detail: '', timestamp: new Date() });
  const payResult = await qbo.create('payment', {
    CustomerRef: custRef,
    TotalAmt: 750.00,
    TxnDate: daysAgo(7),
    // No Line with LinkedTxn — unapplied payment
  });
  const payment = payResult.Payment;
  createdEntities.push({ entity: 'Payment', qboId: payment.Id, step: 1 });
  log[0] = { ...log[0], outcome: 'success', detail: `Payment $750 with no linked invoice — orphaned/unapplied` };

  return { createdEntities, log };
}

// --- Registry ---

const PACK_EXECUTORS = {
  'ar-mismatch': executeArMismatch,
  'duplicate-payment': executeDuplicatePayment,
  'tax-code-inconsistency': executeTaxCodeInconsistency,
  'unapplied-credit': executeUnappliedCredit,
  'orphaned-payment': executeOrphanedPayment,
};

/**
 * Execute a pack by slug.
 */
async function executePack(slug, qbo, entityData) {
  const executor = PACK_EXECUTORS[slug];
  if (!executor) {
    throw new Error(`Unknown issue pack: ${slug}`);
  }
  return executor(qbo, entityData);
}

module.exports = { executePack, PACK_EXECUTORS };
