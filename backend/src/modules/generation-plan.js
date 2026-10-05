/**
 * Format a date N days ago as YYYY-MM-DD for QBO TxnDate.
 */
function daysAgo(n, anchorDate) {
  const d = new Date(anchorDate);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
}

/**
 * Random integer between min and max (inclusive).
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Random amount in a range with 2-decimal precision.
 */
function randAmount(min, max) {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

/**
 * Pick a random element from an array, weighted toward first ~30% for realism.
 */
function pickWeighted(arr) {
  if (!arr.length) return null;
  const frequentCut = Math.max(1, Math.ceil(arr.length * 0.3));
  if (Math.random() < 0.7) {
    return arr[randInt(0, frequentCut - 1)];
  }
  return arr[randInt(0, arr.length - 1)];
}

// --- Query helpers ---

async function queryEntities(qbo, entity, nameField, prefix) {
  const result = await qbo.query(
    `SELECT * FROM ${entity} WHERE ${nameField} LIKE '${prefix}%' MAXRESULTS 1000`
  );
  return result.QueryResponse?.[entity] || [];
}

async function queryAccounts(qbo, accountType) {
  const result = await qbo.query(
    `SELECT * FROM Account WHERE AccountType = '${accountType}' MAXRESULTS 10`
  );
  return result.QueryResponse?.Account || [];
}

/**
 * Record transaction display metadata in the in-memory plan.
 */
function recordTxn(genRun, txnRecord) {
  genRun.createdTransactions.push({
    entity: txnRecord.entity,
    qboId: txnRecord.qboId,
    docNumber: txnRecord.docNumber || '',
    amount: txnRecord.amount,
    txnDate: txnRecord.txnDate,
    linkedTo: txnRecord.linkedTo || '',
    customerOrVendor: txnRecord.customerOrVendor || '',
    chainIndex: txnRecord.chainIndex,
    timestamp: new Date(),
  });
}

// --- Chain builders ---

/**
 * Create an AR chain: invoice -> payment (full/partial) -> optional credit memo.
 * Records every transaction created.
 */
async function createARChain(qbo, { customer, item, txnDate, amount, chainIndex, genRun }) {
  const created = { invoices: 0, payments: 0, creditMemos: 0 };
  const custRef = { value: customer.Id, name: customer.DisplayName };
  const itemRef = { value: item.Id, name: item.Name };
  const custName = customer.DisplayName;

  // Create invoice
  const invResult = await qbo.create('invoice', {
    CustomerRef: custRef,
    TxnDate: txnDate,
    Line: [
      {
        Amount: amount,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { ItemRef: itemRef, UnitPrice: amount, Qty: 1 },
      },
    ],
  });
  const invoice = invResult.Invoice;
  if (!invoice) return created;
  created.invoices = 1;

  const invTxn = {
    entity: 'Invoice', qboId: invoice.Id, docNumber: invoice.DocNumber,
    amount, txnDate, customerOrVendor: custName, chainIndex, linkedTo: '',
  };
  recordTxn(genRun, invTxn);

  // Determine payment behavior: 60% full, 25% partial, 15% unpaid
  const roll = Math.random();
  if (roll < 0.15) {
    return created;
  }

  const payDaysLater = randInt(5, 25);
  const invoiceDateObj = new Date(txnDate);
  const payDate = new Date(invoiceDateObj);
  payDate.setUTCDate(payDate.getUTCDate() + payDaysLater);
  const payDateStr = payDate.toISOString().split('T')[0];
  const payAmount = roll < 0.40 ? randAmount(amount * 0.3, amount * 0.8) : amount;

  const payResult = await qbo.create('payment', {
    CustomerRef: custRef,
    TotalAmt: payAmount,
    TxnDate: payDateStr,
    Line: [
      {
        Amount: payAmount,
        LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
      },
    ],
  });
  const payment = payResult.Payment;
  created.payments = 1;

  const payTxn = {
    entity: 'Payment', qboId: payment.Id, docNumber: payment.DocNumber || '',
    amount: payAmount, txnDate: payDateStr, customerOrVendor: custName,
    chainIndex, linkedTo: `Invoice #${invoice.Id}`,
  };
  recordTxn(genRun, payTxn);

  // ~10% chance of credit memo
  if (Math.random() < 0.10) {
    const cmDaysLater = randInt(1, 10);
    const cmDate = new Date(payDate);
    cmDate.setUTCDate(cmDate.getUTCDate() + cmDaysLater);
    const cmDateStr = cmDate.toISOString().split('T')[0];
    const cmAmount = randAmount(amount * 0.05, amount * 0.2);

    const cmResult = await qbo.create('creditmemo', {
      CustomerRef: custRef,
      TxnDate: cmDateStr,
      Line: [
        {
          Amount: cmAmount,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: itemRef, UnitPrice: cmAmount, Qty: 1 },
        },
      ],
    });
    const cm = cmResult.CreditMemo;
    created.creditMemos = 1;

    const cmTxn = {
      entity: 'CreditMemo', qboId: cm.Id, docNumber: cm.DocNumber || '',
      amount: cmAmount, txnDate: cmDateStr, customerOrVendor: custName,
      chainIndex, linkedTo: `Invoice #${invoice.Id}`,
    };
    recordTxn(genRun, cmTxn);
    }

  return created;
}

/**
 * Create an AP chain: bill -> bill payment -> optional vendor credit.
 * Records every transaction created.
 */
async function createAPChain(qbo, { vendor, expenseAccount, bankAccount, txnDate, amount, chainIndex, genRun }) {
  const created = { bills: 0, billPayments: 0, vendorCredits: 0 };
  const vendorRef = { value: vendor.Id, name: vendor.DisplayName };
  const expenseRef = { value: expenseAccount.Id };
  const bankRef = { value: bankAccount.Id };
  const vendorName = vendor.DisplayName;

  // Create bill
  const billResult = await qbo.create('bill', {
    VendorRef: vendorRef,
    TxnDate: txnDate,
    Line: [
      {
        Amount: amount,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: expenseRef },
      },
    ],
  });
  const bill = billResult.Bill;
  if (!bill) return created;
  created.bills = 1;

  const billTxn = {
    entity: 'Bill', qboId: bill.Id, docNumber: bill.DocNumber || '',
    amount, txnDate, customerOrVendor: vendorName, chainIndex, linkedTo: '',
  };
  recordTxn(genRun, billTxn);

  // Pay the bill (85% of the time)
  if (Math.random() < 0.85) {
    const payDaysLater = randInt(10, 30);
    const billDateObj = new Date(txnDate);
    const payDate = new Date(billDateObj);
    payDate.setUTCDate(payDate.getUTCDate() + payDaysLater);
    const payDateStr = payDate.toISOString().split('T')[0];

    const bpResult = await qbo.create('billpayment', {
      VendorRef: vendorRef,
      TotalAmt: amount,
      TxnDate: payDateStr,
      PayType: 'Check',
      CheckPayment: { BankAccountRef: bankRef },
      Line: [
        {
          Amount: amount,
          LinkedTxn: [{ TxnId: bill.Id, TxnType: 'Bill' }],
        },
      ],
    });
    const bp = bpResult.BillPayment;
    created.billPayments = 1;

    const bpTxn = {
      entity: 'BillPayment', qboId: bp.Id, docNumber: bp.DocNumber || '',
      amount, txnDate: payDateStr, customerOrVendor: vendorName,
      chainIndex, linkedTo: `Bill #${bill.Id}`,
    };
    recordTxn(genRun, bpTxn);
    }

  // ~10% chance of vendor credit
  if (Math.random() < 0.10) {
    const vcDate = new Date(txnDate);
    vcDate.setUTCDate(vcDate.getUTCDate() + randInt(5, 20));
    const vcDateStr = vcDate.toISOString().split('T')[0];
    const vcAmount = randAmount(amount * 0.05, amount * 0.2);

    const vcResult = await qbo.create('vendorcredit', {
      VendorRef: vendorRef,
      TxnDate: vcDateStr,
      Line: [
        {
          Amount: vcAmount,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: expenseRef },
        },
      ],
    });
    const vc = vcResult.VendorCredit;
    created.vendorCredits = 1;

    const vcTxn = {
      entity: 'VendorCredit', qboId: vc.Id, docNumber: vc.DocNumber || '',
      amount: vcAmount, txnDate: vcDateStr, customerOrVendor: vendorName,
      chainIndex, linkedTo: `Bill #${bill.Id}`,
    };
    recordTxn(genRun, vcTxn);
    }

  return created;
}

/**
 * Create a journal entry for period-end adjustments.
 */
async function createJournalEntry(qbo, { debitAccount, creditAccount, txnDate, amount, memo, chainIndex, genRun }) {
  const jeResult = await qbo.create('journalentry', {
    TxnDate: txnDate,
    Line: [
      {
        Amount: amount,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { value: debitAccount.Id },
        },
        Description: memo,
      },
      {
        Amount: amount,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: { value: creditAccount.Id },
        },
        Description: memo,
      },
    ],
  });
  const je = jeResult.JournalEntry;

  const jeTxn = {
    entity: 'JournalEntry', qboId: je.Id, docNumber: je.DocNumber || '',
    amount, txnDate, customerOrVendor: '', chainIndex, linkedTo: '',
  };
  recordTxn(genRun, jeTxn);

  return { journalEntries: 1 };
}

/**
 * Generate a month's worth of transactions.
 */
async function generateMonth(qbo, { customers, vendors, items, expenseAccounts, bankAccounts, incomeAccounts, monthOffset, config, genRun }) {
  const { txnsPerMonth, arWeight } = config;
  const arCount = Math.round(txnsPerMonth * arWeight);
  const apCount = txnsPerMonth - arCount;

  const summary = {
    invoices: 0, payments: 0, creditMemos: 0,
    bills: 0, billPayments: 0, vendorCredits: 0,
    journalEntries: 0, deposits: 0,
  };

  const baseDay = monthOffset * 30;
  let txnCount = 0;
  let chainIndex = genRun.createdTransactions.length;

  // AR chains
  for (let i = 0; i < arCount; i++) {
    try {
      const dayOffset = baseDay + randInt(0, 28);
      const txnDate = daysAgo(dayOffset, config.anchorDate);
      const amount = randAmount(500, 5000);
      chainIndex++;
      const result = await createARChain(qbo, {
        customer: pickWeighted(customers),
        item: pickWeighted(items),
        txnDate,
        amount,
        chainIndex,
        genRun,
      });
      summary.invoices += result.invoices;
      summary.payments += result.payments;
      summary.creditMemos += result.creditMemos;
    } catch (err) {
      throw err;
    }
    txnCount++;

    if (txnCount % 5 === 0) {
      genRun.progress.detail = `Month ${config.monthsBack - monthOffset}/${config.monthsBack}: ${txnCount}/${txnsPerMonth} chains`;
      genRun.progress.totalTxns = genRun.createdTransactions.length;
      await genRun.save();
    }
  }

  // AP chains
  for (let i = 0; i < apCount; i++) {
    try {
      const dayOffset = baseDay + randInt(0, 28);
      const txnDate = daysAgo(dayOffset, config.anchorDate);
      const amount = randAmount(200, 3000);
      chainIndex++;
      const result = await createAPChain(qbo, {
        vendor: pickWeighted(vendors),
        expenseAccount: pickWeighted(expenseAccounts),
        bankAccount: bankAccounts[0],
        txnDate,
        amount,
        chainIndex,
        genRun,
      });
      summary.bills += result.bills;
      summary.billPayments += result.billPayments;
      summary.vendorCredits += result.vendorCredits;
    } catch (err) {
      throw err;
    }
    txnCount++;

    if (txnCount % 5 === 0) {
      genRun.progress.detail = `Month ${config.monthsBack - monthOffset}/${config.monthsBack}: ${txnCount}/${txnsPerMonth} chains`;
      genRun.progress.totalTxns = genRun.createdTransactions.length;
      await genRun.save();
    }
  }

  // 1-2 journal entries per month
  const jeCount = randInt(1, 2);
  for (let i = 0; i < jeCount; i++) {
    try {
      if (expenseAccounts.length && incomeAccounts.length) {
        const txnDate = daysAgo(baseDay + 28, config.anchorDate);
        const amount = randAmount(100, 1000);
        chainIndex++;
        await createJournalEntry(qbo, {
          debitAccount: pickWeighted(expenseAccounts),
          creditAccount: pickWeighted(incomeAccounts),
          txnDate,
          amount,
          memo: `Period adjustment month ${config.monthsBack - monthOffset}`,
          chainIndex,
          genRun,
        });
        summary.journalEntries++;
      }
    } catch (err) {
      throw err;
    }
  }

  return summary;
}


// Planning uses only a local recorder. No QBO, database, or audit calls occur here.
async function buildGenerationPlan(config, data) {
  const steps = [];
  const names = { invoice: 'Invoice', payment: 'Payment', creditmemo: 'CreditMemo', bill: 'Bill', billpayment: 'BillPayment', vendorcredit: 'VendorCredit', journalentry: 'JournalEntry' };
  const recorder = {
    async create(entity, payload) {
      const id = '$step:' + steps.length;
      steps.push({ entity, payload, state: 'pending' });
      return { [names[entity]]: { Id: id } };
    },
  };
  const memory = { createdTransactions: [], generationErrors: [], progress: {}, async save() {} };
  for (let m = config.monthsBack - 1; m >= 0; m--) {
    await generateMonth(recorder, { ...data, monthOffset: m, config, genRun: memory });
  }
  return steps.map((step, index) => ({ ...step, transaction: memory.createdTransactions[index] }));
}

module.exports = { buildGenerationPlan, queryEntities, queryAccounts };
