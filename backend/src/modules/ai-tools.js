const Checkpoint = require('../models/Checkpoint');
const IssuePack = require('../models/IssuePack');
const IssuePackRun = require('../models/IssuePackRun');
const { createCheckpoint, diffCheckpoints } = require('./checkpoint');
const { executePack } = require('./issuepack-engine');

const VALID_ENTITY_TYPES = [
  'Customer', 'Invoice', 'Payment', 'CreditMemo',
  'Bill', 'BillPayment', 'VendorCredit',
  'Vendor', 'Item', 'Account', 'JournalEntry', 'Estimate', 'Deposit',
];

/**
 * Sanitize a string for use inside QBO query LIKE clauses.
 * Escapes single quotes and strips control characters.
 */
function sanitizeQueryString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/['\\\x00-\x1f]/g, '').trim();
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic API format)
// ---------------------------------------------------------------------------

const toolDefinitions = [
  // --- Read tools ---
  {
    name: 'lookupCustomer',
    description:
      'Search for QBO customers by display name. Returns matching customer records with Id, DisplayName, Balance, and contact info.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Customer display name (or partial name) to search for',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'lookupInvoice',
    description:
      'Search for QBO invoices by document number or customer name. Returns matching invoice records with Id, DocNumber, TotalAmt, Balance, CustomerRef, and TxnDate.',
    input_schema: {
      type: 'object',
      properties: {
        docNumber: {
          type: 'string',
          description: 'Invoice document number to search for',
        },
        customerName: {
          type: 'string',
          description: 'Customer name to filter invoices by',
        },
      },
      required: [],
    },
  },
  {
    name: 'searchEntities',
    description:
      'Generic search across any QBO entity type. Use for vendors, items, accounts, bills, payments, credit memos, journal entries, estimates, deposits, and more.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: VALID_ENTITY_TYPES,
          description: 'The QBO entity type to search',
        },
        query: {
          type: 'string',
          description:
            'Search term — matched against DisplayName (for people) or Name (for items/accounts) or DocNumber (for transactions)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10, max 100)',
        },
      },
      required: ['type', 'query'],
    },
  },
  {
    name: 'getEntityDetail',
    description:
      'Read the full detail of a single QBO entity by type and ID. Returns all fields including line items, linked transactions, and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: VALID_ENTITY_TYPES,
          description: 'The QBO entity type',
        },
        id: {
          type: 'string',
          description: 'The QBO entity ID',
        },
      },
      required: ['type', 'id'],
    },
  },
  {
    name: 'getTransactionChain',
    description:
      'Trace linked transactions starting from a given entity. Follows LinkedTxn references recursively to build the full transaction graph (e.g., Invoice -> Payment -> CreditMemo chain).',
    input_schema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          enum: VALID_ENTITY_TYPES,
          description: 'The starting entity type',
        },
        entityId: {
          type: 'string',
          description: 'The starting entity ID',
        },
      },
      required: ['entityType', 'entityId'],
    },
  },
  {
    name: 'getChangeSummary',
    description:
      'Get a summary of changes between two checkpoints, or list recent checkpoints. When checkpoint IDs are provided, returns a diff showing added, modified, and deleted entities.',
    input_schema: {
      type: 'object',
      properties: {
        checkpointA: {
          type: 'string',
          description: 'ID of the earlier checkpoint (base)',
        },
        checkpointB: {
          type: 'string',
          description: 'ID of the later checkpoint (compare)',
        },
        since: {
          type: 'string',
          description:
            'ISO date string — if no checkpoint IDs given, list checkpoints created after this date',
        },
      },
      required: [],
    },
  },

  // --- Write tools ---
  {
    name: 'createInvoice',
    description:
      'Create a new QBO invoice for a customer. Requires customer reference, line items, and transaction date.',
    input_schema: {
      type: 'object',
      properties: {
        customerRef: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Customer QBO ID' },
            name: { type: 'string', description: 'Customer display name' },
          },
          required: ['id', 'name'],
          description: 'Reference to the customer',
        },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Line description' },
              amount: { type: 'number', description: 'Line amount' },
              itemRef: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Item QBO ID' },
                  name: { type: 'string', description: 'Item name' },
                },
                required: ['id', 'name'],
                description: 'Optional item reference',
              },
            },
            required: ['description', 'amount'],
          },
          description: 'Invoice line items',
        },
        txnDate: {
          type: 'string',
          description: 'Transaction date in YYYY-MM-DD format',
        },
      },
      required: ['customerRef', 'lines', 'txnDate'],
    },
  },
  {
    name: 'applyPayment',
    description:
      'Apply a payment to an existing invoice. Links the payment to the specified invoice.',
    input_schema: {
      type: 'object',
      properties: {
        customerRef: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Customer QBO ID' },
            name: { type: 'string', description: 'Customer display name' },
          },
          required: ['id', 'name'],
          description: 'Reference to the customer',
        },
        invoiceId: {
          type: 'string',
          description: 'QBO ID of the invoice to apply payment to',
        },
        amount: {
          type: 'number',
          description: 'Payment amount',
        },
        txnDate: {
          type: 'string',
          description: 'Payment date in YYYY-MM-DD format',
        },
      },
      required: ['customerRef', 'invoiceId', 'amount', 'txnDate'],
    },
  },
  {
    name: 'createBill',
    description:
      'Create a new QBO bill (accounts payable) for a vendor. Requires vendor reference, line items, and transaction date.',
    input_schema: {
      type: 'object',
      properties: {
        vendorRef: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Vendor QBO ID' },
            name: { type: 'string', description: 'Vendor display name' },
          },
          required: ['id', 'name'],
          description: 'Reference to the vendor',
        },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Line description' },
              amount: { type: 'number', description: 'Line amount' },
              accountRef: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Account QBO ID' },
                  name: { type: 'string', description: 'Account name' },
                },
                required: ['id', 'name'],
                description: 'Optional expense account reference',
              },
            },
            required: ['description', 'amount'],
          },
          description: 'Bill line items',
        },
        txnDate: {
          type: 'string',
          description: 'Transaction date in YYYY-MM-DD format',
        },
      },
      required: ['vendorRef', 'lines', 'txnDate'],
    },
  },
  {
    name: 'applyBillPayment',
    description:
      'Pay an existing bill. Creates a bill payment linked to the specified bill.',
    input_schema: {
      type: 'object',
      properties: {
        vendorRef: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Vendor QBO ID' },
            name: { type: 'string', description: 'Vendor display name' },
          },
          required: ['id', 'name'],
          description: 'Reference to the vendor',
        },
        billId: {
          type: 'string',
          description: 'QBO ID of the bill to pay',
        },
        amount: {
          type: 'number',
          description: 'Payment amount',
        },
        txnDate: {
          type: 'string',
          description: 'Payment date in YYYY-MM-DD format',
        },
      },
      required: ['vendorRef', 'billId', 'amount', 'txnDate'],
    },
  },
  {
    name: 'runIssuePack',
    description:
      'Execute a named issue pack to generate a realistic support scenario. Creates QBO entities that simulate common issues (e.g., AR mismatch, duplicate payment, unapplied credit).',
    input_schema: {
      type: 'object',
      properties: {
        packId: {
          type: 'string',
          description:
            'The issue pack slug (e.g., "ar-mismatch", "duplicate-payment", "tax-code-inconsistency", "unapplied-credit", "orphaned-payment")',
        },
      },
      required: ['packId'],
    },
  },
  {
    name: 'createCheckpoint',
    description:
      'Create a snapshot (checkpoint) of the current state of all key entities in the QBO company. Used to track changes over time and diff before/after states.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A descriptive name for this checkpoint',
        },
        description: {
          type: 'string',
          description: 'Optional detailed description of why this checkpoint is being created',
        },
      },
      required: ['name'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Each handler receives (input, context) where context = { qbo, userId, realmId, connection }.
 * All handlers return { success: boolean, data?: any, error?: string }.
 */

async function handleLookupCustomer(input, context) {
  const name = sanitizeQueryString(input.name);
  if (!name) {
    return { success: false, error: 'Customer name is required' };
  }

  const queryStr = `SELECT * FROM Customer WHERE DisplayName LIKE '%${name}%' MAXRESULTS 20`;
  const result = await context.qbo.query(queryStr);
  const customers = result.QueryResponse?.Customer || [];

  return {
    success: true,
    data: {
      count: customers.length,
      customers: customers.map((c) => ({
        id: c.Id,
        displayName: c.DisplayName,
        balance: c.Balance,
        email: c.PrimaryEmailAddr?.Address || null,
        phone: c.PrimaryPhone?.FreeFormNumber || null,
        active: c.Active,
      })),
    },
  };
}

async function handleLookupInvoice(input, context) {
  const docNumber = sanitizeQueryString(input.docNumber || '');
  const customerName = sanitizeQueryString(input.customerName || '');

  if (!docNumber && !customerName) {
    return { success: false, error: 'At least one of docNumber or customerName is required' };
  }

  let queryStr = 'SELECT * FROM Invoice';
  const conditions = [];

  if (docNumber) {
    conditions.push(`DocNumber LIKE '%${docNumber}%'`);
  }
  if (customerName) {
    conditions.push(`CustomerRef LIKE '%${customerName}%'`);
  }

  if (conditions.length > 0) {
    queryStr += ' WHERE ' + conditions.join(' AND ');
  }
  queryStr += ' MAXRESULTS 20';

  const result = await context.qbo.query(queryStr);
  const invoices = result.QueryResponse?.Invoice || [];

  return {
    success: true,
    data: {
      count: invoices.length,
      invoices: invoices.map((inv) => ({
        id: inv.Id,
        docNumber: inv.DocNumber,
        txnDate: inv.TxnDate,
        totalAmt: inv.TotalAmt,
        balance: inv.Balance,
        customerRef: inv.CustomerRef,
        dueDate: inv.DueDate,
        linkedTxns: inv.LinkedTxn || [],
      })),
    },
  };
}

async function handleSearchEntities(input, context) {
  const { type } = input;
  const query = sanitizeQueryString(input.query);
  const limit = Math.min(Math.max(input.limit || 10, 1), 100);

  if (!VALID_ENTITY_TYPES.includes(type)) {
    return {
      success: false,
      error: `Invalid entity type "${type}". Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    };
  }

  let queryStr = `SELECT * FROM ${type}`;

  if (query) {
    // Items and Accounts use Name; transactions use DocNumber; people use DisplayName
    const nameField = ['Item', 'Account'].includes(type) ? 'Name' : 'DisplayName';
    const txnTypes = [
      'Invoice', 'Bill', 'Payment', 'CreditMemo', 'BillPayment',
      'VendorCredit', 'Estimate', 'JournalEntry', 'Deposit',
    ];
    if (txnTypes.includes(type)) {
      queryStr += ` WHERE DocNumber LIKE '%${query}%'`;
    } else {
      queryStr += ` WHERE ${nameField} LIKE '%${query}%'`;
    }
  }

  queryStr += ` MAXRESULTS ${limit}`;

  const result = await context.qbo.query(queryStr);
  const records = result.QueryResponse?.[type] || [];

  return {
    success: true,
    data: { type, count: records.length, records },
  };
}

async function handleGetEntityDetail(input, context) {
  const { type, id } = input;

  if (!VALID_ENTITY_TYPES.includes(type)) {
    return {
      success: false,
      error: `Invalid entity type "${type}". Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    };
  }

  const result = await context.qbo.read(type.toLowerCase(), id);
  // QBO returns { Invoice: {...} } or { Customer: {...} } etc.
  const entityKey = Object.keys(result).find((k) => k !== 'time');
  const record = entityKey ? result[entityKey] : result;

  return {
    success: true,
    data: { type, id, record },
  };
}

async function handleGetTransactionChain(input, context) {
  const { entityType, entityId } = input;

  if (!VALID_ENTITY_TYPES.includes(entityType)) {
    return {
      success: false,
      error: `Invalid entity type "${entityType}". Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    };
  }

  const visited = new Set();
  const nodes = [];
  const edges = [];

  async function trace(eType, eId) {
    const key = `${eType}:${eId}`;
    if (visited.has(key)) return;
    visited.add(key);

    try {
      const result = await context.qbo.read(eType.toLowerCase(), eId);
      const entityKey = Object.keys(result).find((k) => k !== 'time');
      const record = entityKey ? result[entityKey] : result;

      nodes.push({ entity: eType, id: eId, data: record });

      // Follow top-level LinkedTxn references
      const linkedTxns = record.LinkedTxn || [];
      for (const link of linkedTxns) {
        edges.push({
          from: key,
          to: `${link.TxnType}:${link.TxnId}`,
          linkType: 'LinkedTxn',
        });
        await trace(link.TxnType, link.TxnId);
      }

      // Follow Line-level LinkedTxn (e.g., Payment lines linking to Invoices)
      const lines = record.Line || [];
      for (const line of lines) {
        const lineLinks = line.LinkedTxn || [];
        for (const link of lineLinks) {
          edges.push({
            from: key,
            to: `${link.TxnType}:${link.TxnId}`,
            linkType: 'LineLinkedTxn',
          });
          await trace(link.TxnType, link.TxnId);
        }
      }
    } catch (err) {
      // Entity might not be readable — record the error but continue
      nodes.push({ entity: eType, id: eId, error: err.message });
    }
  }

  await trace(entityType, entityId);

  return {
    success: true,
    data: { nodes, edges },
  };
}

async function handleGetChangeSummary(input, context) {
  const { checkpointA, checkpointB, since } = input;

  // If both checkpoint IDs provided, compute a diff
  if (checkpointA && checkpointB) {
    const [cpA, cpB] = await Promise.all([
      Checkpoint.findOne({ _id: checkpointA, userId: context.userId, realmId: context.realmId }),
      Checkpoint.findOne({ _id: checkpointB, userId: context.userId, realmId: context.realmId }),
    ]);

    if (!cpA) {
      return { success: false, error: `Checkpoint A not found: ${checkpointA}` };
    }
    if (!cpB) {
      return { success: false, error: `Checkpoint B not found: ${checkpointB}` };
    }

    const diff = await diffCheckpoints(cpA, cpB);

    return {
      success: true,
      data: {
        checkpointA: { id: cpA._id, name: cpA.name, createdAt: cpA.createdAt },
        checkpointB: { id: cpB._id, name: cpB.name, createdAt: cpB.createdAt },
        diff,
      },
    };
  }

  // Otherwise, list recent checkpoints
  const filter = { userId: context.userId, realmId: context.realmId };
  if (since) {
    filter.createdAt = { $gte: new Date(since) };
  }

  const checkpoints = await Checkpoint.find(filter)
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return {
    success: true,
    data: {
      count: checkpoints.length,
      checkpoints: checkpoints.map((cp) => ({
        id: cp._id,
        name: cp.name,
        description: cp.description,
        entityCounts: cp.entityCounts,
        createdAt: cp.createdAt,
      })),
    },
  };
}

async function handleCreateInvoice(input, context) {
  const { customerRef, lines, txnDate } = input;

  const qboLines = lines.map((line) => {
    const lineObj = {
      Amount: line.amount,
      DetailType: 'SalesItemLineDetail',
      Description: line.description,
      SalesItemLineDetail: {
        UnitPrice: line.amount,
        Qty: 1,
      },
    };
    if (line.itemRef) {
      lineObj.SalesItemLineDetail.ItemRef = {
        value: line.itemRef.id,
        name: line.itemRef.name,
      };
    }
    return lineObj;
  });

  const invoiceData = {
    CustomerRef: { value: customerRef.id, name: customerRef.name },
    TxnDate: txnDate,
    Line: qboLines,
  };

  const result = await context.qbo.create('invoice', invoiceData);
  const invoice = result.Invoice;

  return {
    success: true,
    data: {
      id: invoice.Id,
      docNumber: invoice.DocNumber,
      totalAmt: invoice.TotalAmt,
      balance: invoice.Balance,
      txnDate: invoice.TxnDate,
      customerRef: invoice.CustomerRef,
    },
  };
}

async function handleApplyPayment(input, context) {
  const { customerRef, invoiceId, amount, txnDate } = input;

  const paymentData = {
    CustomerRef: { value: customerRef.id, name: customerRef.name },
    TotalAmt: amount,
    TxnDate: txnDate,
    Line: [
      {
        Amount: amount,
        LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }],
      },
    ],
  };

  const result = await context.qbo.create('payment', paymentData);
  const payment = result.Payment;

  return {
    success: true,
    data: {
      id: payment.Id,
      totalAmt: payment.TotalAmt,
      txnDate: payment.TxnDate,
      customerRef: payment.CustomerRef,
      linkedInvoiceId: invoiceId,
    },
  };
}

async function handleCreateBill(input, context) {
  const { vendorRef, lines, txnDate } = input;

  const qboLines = lines.map((line) => {
    const lineObj = {
      Amount: line.amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: line.description,
      AccountBasedExpenseLineDetail: {},
    };
    if (line.accountRef) {
      lineObj.AccountBasedExpenseLineDetail.AccountRef = {
        value: line.accountRef.id,
        name: line.accountRef.name,
      };
    }
    return lineObj;
  });

  const billData = {
    VendorRef: { value: vendorRef.id, name: vendorRef.name },
    TxnDate: txnDate,
    Line: qboLines,
  };

  const result = await context.qbo.create('bill', billData);
  const bill = result.Bill;

  return {
    success: true,
    data: {
      id: bill.Id,
      docNumber: bill.DocNumber,
      totalAmt: bill.TotalAmt,
      balance: bill.Balance,
      txnDate: bill.TxnDate,
      vendorRef: bill.VendorRef,
    },
  };
}

async function handleApplyBillPayment(input, context) {
  const { vendorRef, billId, amount, txnDate } = input;

  // Need a bank account for CheckPayment — query for one
  const bankResult = await context.qbo.query(
    "SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 1"
  );
  const bankAccounts = bankResult.QueryResponse?.Account || [];
  if (bankAccounts.length === 0) {
    return { success: false, error: 'No bank account found. Cannot create bill payment without a bank account.' };
  }

  const billPaymentData = {
    VendorRef: { value: vendorRef.id, name: vendorRef.name },
    TotalAmt: amount,
    TxnDate: txnDate,
    PayType: 'Check',
    CheckPayment: {
      BankAccountRef: { value: bankAccounts[0].Id },
    },
    Line: [
      {
        Amount: amount,
        LinkedTxn: [{ TxnId: billId, TxnType: 'Bill' }],
      },
    ],
  };

  const result = await context.qbo.create('billpayment', billPaymentData);
  const bp = result.BillPayment;

  return {
    success: true,
    data: {
      id: bp.Id,
      totalAmt: bp.TotalAmt,
      txnDate: bp.TxnDate,
      vendorRef: bp.VendorRef,
      linkedBillId: billId,
    },
  };
}

async function handleRunIssuePack(input, context) {
  const { packId } = input;
  const { createAuditEntry: auditEntry } = require('../middleware/auditLogger');

  // Look up the pack definition
  const pack = await IssuePack.findOne({ slug: packId });
  if (!pack) {
    return { success: false, error: `Issue pack not found: "${packId}"` };
  }

  // Create run record up-front (matches manual route pattern — tracks in_progress state)
  const run = await IssuePackRun.create({
    userId: context.userId,
    realmId: context.realmId,
    issuePackId: pack._id,
    status: 'in_progress',
    startedAt: new Date(),
  });

  // Load entity data needed by pack executors (same approach as issuepacks route)
  const [custResult, vendResult, itemResult, expResult, bankResult] = await Promise.all([
    context.qbo.query("SELECT * FROM Customer WHERE DisplayName LIKE 'TestCust%' MAXRESULTS 100"),
    context.qbo.query("SELECT * FROM Vendor WHERE DisplayName LIKE 'TestVendor%' MAXRESULTS 100"),
    context.qbo.query("SELECT * FROM Item WHERE Name LIKE 'TestSvc%' MAXRESULTS 100"),
    context.qbo.query("SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 10"),
    context.qbo.query("SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 10"),
  ]);

  const entityData = {
    customers: custResult.QueryResponse?.Customer || [],
    vendors: vendResult.QueryResponse?.Vendor || [],
    items: itemResult.QueryResponse?.Item || [],
    expenseAccounts: expResult.QueryResponse?.Account || [],
    bankAccounts: bankResult.QueryResponse?.Account || [],
  };

  // Prerequisite checks (same as manual route in issuepacks.js)
  if (['ar-mismatch', 'tax-code-inconsistency', 'unapplied-credit', 'orphaned-payment'].includes(pack.slug)) {
    if (!entityData.customers.length || !entityData.items.length) {
      run.status = 'failed';
      run.completedAt = new Date();
      run.executionLog = [{ step: 0, action: 'prerequisite', outcome: 'failure', detail: 'Need customers and items. Run seeding first.' }];
      await run.save();
      return { success: false, error: 'Prerequisite failed: need customers and items. Run seeding first.' };
    }
  }
  if (['duplicate-payment'].includes(pack.slug)) {
    if (!entityData.vendors.length || !entityData.expenseAccounts.length || !entityData.bankAccounts.length) {
      run.status = 'failed';
      run.completedAt = new Date();
      run.executionLog = [{ step: 0, action: 'prerequisite', outcome: 'failure', detail: 'Need vendors, expense accounts, and bank accounts. Run seeding first.' }];
      await run.save();
      return { success: false, error: 'Prerequisite failed: need vendors, expense accounts, and bank accounts. Run seeding first.' };
    }
  }

  // Execute the pack
  const result = await executePack(pack.slug, context.qbo, entityData);

  // Update run record
  run.createdEntities = result.createdEntities;
  run.executionLog = result.log;
  run.status = 'completed';
  run.completedAt = new Date();
  await run.save();

  // Per-entity audit trail (matches manual route pattern)
  for (const entity of result.createdEntities) {
    const logEntry = result.log.find((l) => l.step === entity.step);
    await auditEntry(context.userId, context.realmId, `Issue pack "${pack.name}" created ${entity.entity} #${entity.qboId}`, {
      actionType: 'issue_pack_entity',
      outcome: 'success',
      aiDriven: true,
      afterState: {
        runId: run._id,
        slug: pack.slug,
        entity: entity.entity,
        qboId: entity.qboId,
        step: entity.step,
        detail: logEntry?.detail || '',
      },
    });
  }

  // Pack-level audit entry
  await auditEntry(context.userId, context.realmId, `Issue pack completed: ${pack.name}`, {
    actionType: 'issue_pack',
    outcome: 'success',
    aiDriven: true,
    afterState: {
      runId: run._id,
      slug: pack.slug,
      entitiesCreated: result.createdEntities.length,
    },
  });

  return {
    success: true,
    data: {
      runId: run._id,
      packSlug: pack.slug,
      packName: pack.name,
      entitiesCreated: result.createdEntities.length,
      createdEntities: result.createdEntities,
      log: result.log,
    },
  };
}

async function handleCreateCheckpoint(input, context) {
  const checkpoint = await createCheckpoint(context.qbo, {
    userId: context.userId,
    realmId: context.realmId,
    name: input.name,
    description: input.description || '',
  });

  return {
    success: true,
    data: {
      id: checkpoint._id,
      name: checkpoint.name,
      description: checkpoint.description,
      entityCounts: checkpoint.entityCounts,
      createdAt: checkpoint.createdAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

const toolHandlers = {
  lookupCustomer: handleLookupCustomer,
  lookupInvoice: handleLookupInvoice,
  searchEntities: handleSearchEntities,
  getEntityDetail: handleGetEntityDetail,
  getTransactionChain: handleGetTransactionChain,
  getChangeSummary: handleGetChangeSummary,
  createInvoice: handleCreateInvoice,
  applyPayment: handleApplyPayment,
  createBill: handleCreateBill,
  applyBillPayment: handleApplyBillPayment,
  runIssuePack: handleRunIssuePack,
  createCheckpoint: handleCreateCheckpoint,
};

const toolPermissions = {
  lookupCustomer: 'auto',
  lookupInvoice: 'auto',
  searchEntities: 'auto',
  getEntityDetail: 'auto',
  getTransactionChain: 'auto',
  getChangeSummary: 'auto',
  createInvoice: 'confirm',
  applyPayment: 'confirm',
  createBill: 'confirm',
  applyBillPayment: 'confirm',
  runIssuePack: 'confirm',
  createCheckpoint: 'confirm',
};

module.exports = {
  toolDefinitions,
  toolHandlers,
  toolPermissions,
  VALID_ENTITY_TYPES,
};
