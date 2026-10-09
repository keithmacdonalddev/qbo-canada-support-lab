const Checkpoint = require('../models/Checkpoint');
const IssuePack = require('../models/IssuePack');
const IssuePackRun = require('../models/IssuePackRun');
const { createCheckpoint, diffCheckpoints } = require('./checkpoint');
const { executePack } = require('./issuepack-engine');

// Record types the assistant may create or edit to reproduce an issue. Every
// such change is queued as a plan step and runs only after the user approves.
// There is deliberately no delete; voiding is limited to the types QBO voids.
const WRITABLE_ENTITY_TYPES = [
  'Customer', 'Vendor', 'Employee', 'Item', 'Account', 'Class', 'Department', 'Term',
  'Invoice', 'Payment', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate',
  'Bill', 'BillPayment', 'VendorCredit', 'Purchase', 'PurchaseOrder',
  'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity',
];

// Company-wide settings, one record per company, read by query (never written):
// whether class/location tracking, multicurrency, custom transaction numbers and
// sales tax are on, the fiscal year, home currency and so on.
const SINGLETON_TYPES = ['Preferences', 'CompanyInfo'];

// Types the read tools accept. Every writable type must be readable, so the
// assistant can look up the references (employee, term, class) a new record needs.
const VALID_ENTITY_TYPES = [...WRITABLE_ENTITY_TYPES, 'TaxCode', 'TaxRate', 'PaymentMethod', ...SINGLETON_TYPES];

// How searchEntities matches its text: by Name, by DocNumber, or (types with
// neither) not at all, returning the most recently updated records instead.
const PEOPLE_TYPES = ['Customer', 'Vendor', 'Employee'];
const NAME_SEARCH_TYPES = ['Item', 'Account', 'Class', 'Department', 'Term', 'TaxCode', 'TaxRate', 'PaymentMethod'];
const LIST_TYPES = [...PEOPLE_TYPES, ...NAME_SEARCH_TYPES];
const UNSEARCHABLE_TEXT_TYPES = ['Transfer', 'TimeActivity'];
// Lists QBO sorts by last update; the remaining small lists come back unsorted.
const SORTABLE_LIST_TYPES = [...PEOPLE_TYPES, 'Item', 'Account'];
const CUSTOMER_TXN_TYPES = ['Invoice', 'Payment', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate'];
const VENDOR_TXN_TYPES = ['Bill', 'BillPayment', 'VendorCredit', 'PurchaseOrder'];
const ACCOUNT_TYPES = [
  'Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset',
  'Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability', 'Equity',
  'Income', 'Other Income', 'Cost of Goods Sold', 'Expense', 'Other Expense',
];
const ITEM_TYPES = ['Service', 'NonInventory', 'Inventory', 'Group', 'Category'];
const VOIDABLE_ENTITY_TYPES = ['Invoice', 'Payment', 'SalesReceipt', 'BillPayment'];

// Reports the QuickBooks Reports API serves, by URL name (docs/discovery/catalog.v1.json
// lists General Ledger and Account List under their report-table names).
const REPORT_NAMES = [
  'BalanceSheet', 'ProfitAndLoss', 'ProfitAndLossDetail', 'TrialBalance', 'GeneralLedger', 'CashFlow',
  'AgedReceivables', 'AgedReceivableDetail', 'AgedPayables', 'AgedPayableDetail',
  'CustomerBalance', 'CustomerBalanceDetail', 'CustomerSales', 'CustomerIncome',
  'VendorBalance', 'VendorBalanceDetail', 'VendorExpenses',
  'ItemSales', 'ClassSales', 'DepartmentSales', 'AccountList',
  'InventoryValuationSummary', 'InventoryValuationDetail', 'TransactionList', 'JournalReport',
];
// Report filters by QBO Id (one, or several comma-separated): tool field -> query parameter.
const REPORT_ID_FILTERS = [
  ['customer', 'customer'], ['vendor', 'vendor'], ['account', 'account'], ['item', 'item'],
  ['class', 'class'], ['department', 'department'],
];
const REPORT_PAGE_LINES = 150;
const REPORT_MAX_PAGE_LINES = 300;
// Lines kept from one report response; later pages are read from these.
const REPORT_MAX_LINES = 5000;

/**
 * Make text safe inside a quoted QBO query value: strips control characters and
 * escapes backslashes and apostrophes with a backslash (QBO query syntax), so
 * "Domino's" is still found.
 */
function escapeQueryString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x1f]/g, '').trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
      'Search any QBO entity type: vendors, employees, items, accounts, terms, tax codes, classes, locations (Department), bills, payments, credit memos, journal entries, estimates, deposits, and more. '
      + 'Returns compact summaries (Id, name or DocNumber, type, date, amounts, party), most recently updated first where QuickBooks supports it; read one record in full with getEntityDetail. '
      + 'Omit query to list records of a type. Page with startPosition. Preferences and CompanyInfo return the company settings record.',
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
            'Text contained in DisplayName (people), Name (items, accounts and other lists) or DocNumber (transactions)',
        },
        filters: {
          type: 'object',
          description: 'Optional exact filters, each only for the types it names',
          properties: {
            active: { type: 'string', enum: ['active', 'inactive', 'all'], description: 'Lists only. Default: QuickBooks returns active records.' },
            accountType: { type: 'string', enum: ACCOUNT_TYPES, description: 'Account only' },
            itemType: { type: 'string', enum: ITEM_TYPES, description: 'Item only' },
            txnDateFrom: { type: 'string', description: 'Transactions only. YYYY-MM-DD, inclusive' },
            txnDateTo: { type: 'string', description: 'Transactions only. YYYY-MM-DD, inclusive' },
            customerId: { type: 'string', description: `QBO customer Id. ${CUSTOMER_TXN_TYPES.join(', ')} only` },
            vendorId: { type: 'string', description: `QBO vendor Id. ${VENDOR_TXN_TYPES.join(', ')} only` },
          },
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10, max 100)',
        },
        startPosition: {
          type: 'number',
          description: '1-based position of the first result, for the next page (default 1)',
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'getEntityDetail',
    description:
      'Read the full detail of a single QBO entity by type and ID. Returns all fields including line items (with line Ids), linked transactions, and metadata. '
      + "For the company's settings use type Preferences (tracking, multicurrency, custom transaction numbers, tax) or CompanyInfo (name, country, fiscal year); their id is ignored, pass \"1\".",
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
  {
    name: 'getCoverage',
    description:
      'Show which QuickBooks feature areas this company actually uses, measured from its records: for each area (sales, payables, banking, tax, projects, dimensions and so on) which signals are in use, stale or missing, '
      + 'when each was last seen, and whether you can create the missing records or a person must do it in QuickBooks. Use it to find gaps to fill, or to check that a reproduction has the surrounding data it needs.',
    input_schema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Optional catalog area key, e.g. sales.receivables-lifecycle. Omit for all areas.' },
        refresh: { type: 'boolean', description: 'Read the company again instead of using a result up to ten minutes old.' },
      },
      required: [],
    },
  },
  {
    name: 'runReport',
    description:
      'Run a QuickBooks report and return its rows as text. Use it to check what a customer would see in a report, or to confirm a reproduction or a filled gap shows up where expected. '
      + 'Filter by customer, vendor, account, item, class or department Id where the report supports it (QuickBooks names any filter it rejects). '
      + `Returns up to ${REPORT_PAGE_LINES} lines per call; when nextOffset is set, call again with rowOffset to read more.`,
    input_schema: {
      type: 'object',
      properties: {
        report: { type: 'string', enum: REPORT_NAMES, description: 'QuickBooks Reports API name' },
        startDate: { type: 'string', description: 'YYYY-MM-DD period start (period reports)' },
        endDate: { type: 'string', description: 'YYYY-MM-DD period end (period reports)' },
        reportDate: { type: 'string', description: 'YYYY-MM-DD as-of date (aging and balance reports)' },
        accountingMethod: { type: 'string', enum: ['Accrual', 'Cash'] },
        summarizeColumnBy: { type: 'string', enum: ['Total', 'Month', 'Quarter', 'Year', 'Customers', 'Vendors', 'Classes', 'Departments'] },
        ...Object.fromEntries(REPORT_ID_FILTERS.map(([field]) => [field, {
          type: 'string', description: `QBO ${field} Id, or several comma-separated`,
        }])),
        rowOffset: { type: 'number', description: 'Number of report lines to skip (default 0)' },
        rowLimit: { type: 'number', description: `Report lines to return (default ${REPORT_PAGE_LINES}, max ${REPORT_MAX_PAGE_LINES})` },
      },
      required: ['report'],
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
  {
    name: 'createRecord',
    description:
      'Create any supported QuickBooks Online record (customer, vendor, item, account, invoice, payment, credit memo, sales receipt, refund, estimate, bill, bill payment, vendor credit, expense/Purchase, purchase order, deposit, transfer, journal entry, time activity). '
      + 'Pass the record body exactly as the QBO Accounting API v3 expects for that entity (e.g. CustomerRef, Line with DetailType, TxnDate, LinkedTxn). '
      + 'Look up the Ids of referenced customers, vendors, items, accounts and tax codes first; never invent Ids. '
      + 'In a Canadian company every sales or purchase line needs a TaxCodeRef (use an exempt or zero-rated code when no tax applies). '
      + 'Inventory items need TrackQtyOnHand, QtyOnHand, InvStartDate and Income, Expense (cost of sales) and Asset account refs. '
      + 'A Purchase needs PaymentType (Cash, Check or CreditCard) and the paying AccountRef; a BillPayment needs PayType with CheckPayment.BankAccountRef or CreditCardPayment.CCAccountRef; Payment and BillPayment apply to documents through Line[].LinkedTxn. '
      + 'In a reproduction case, customers, vendors and other parties (CustomerRef, VendorRef, EntityRef) must be records created in the case. '
      + 'Read the saved record for its real Ids, line Ids and calculated totals. Queued for user approval.',
    input_schema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: WRITABLE_ENTITY_TYPES, description: 'QBO entity name' },
        record: { type: 'object', description: 'QBO API v3 request body for the new record' },
        summary: { type: 'string', description: 'One plain-English sentence describing this change for the reviewer' },
        goal: { type: 'integer', minimum: 1, description: "Which item of the case's opening request this change answers, counting its numbered or bulleted items from 1. Omit when the request has no list." },
      },
      required: ['entityType', 'record', 'summary'],
    },
  },
  {
    name: 'updateRecord',
    description:
      'Change fields on an existing QuickBooks Online record with a sparse update. Pass only the fields to change, in QBO API v3 shape; '
      + 'the server fetches the current SyncToken. Use it to edit amounts, dates, links, memos, terms, statuses (e.g. Active=false) and so on. '
      + 'Line is different: sending Line replaces the whole list, so include every existing line (with its Id) you want to keep, read from the record first. '
      + 'Dropping existing lines is refused unless replaceAllLines is true. Queued for user approval.',
    input_schema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: WRITABLE_ENTITY_TYPES, description: 'QBO entity name' },
        id: { type: 'string', description: 'QBO Id of the record to change' },
        changes: { type: 'object', description: 'Only the fields to set, in QBO API v3 shape' },
        replaceAllLines: { type: 'boolean', description: 'Set true only when changes.Line is the complete new line list and existing lines left out should be removed' },
        summary: { type: 'string', description: 'One plain-English sentence describing this change for the reviewer' },
        goal: { type: 'integer', minimum: 1, description: "Which item of the case's opening request this change answers, counting its numbered or bulleted items from 1. Omit when the request has no list." },
      },
      required: ['entityType', 'id', 'changes', 'summary'],
    },
  },
  {
    name: 'voidTransaction',
    description:
      'Void an invoice, payment, sales receipt or bill payment. The record stays in QuickBooks with zero amounts and a Voided memo. Queued for user approval.',
    input_schema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: VOIDABLE_ENTITY_TYPES, description: 'QBO entity name' },
        id: { type: 'string', description: 'QBO Id of the transaction to void' },
        summary: { type: 'string', description: 'One plain-English sentence describing why it is voided' },
        goal: { type: 'integer', minimum: 1, description: "Which item of the case's opening request this change answers, counting its numbered or bulleted items from 1. Omit when the request has no list." },
      },
      required: ['entityType', 'id', 'summary'],
    },
  }
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Each handler receives (input, context) where context = { qbo, userId, realmId, connection }.
 * All handlers return { success: boolean, data?: any, error?: string }.
 */

async function handleLookupCustomer(input, context) {
  const name = escapeQueryString(input.name);
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
  const docNumber = escapeQueryString(input.docNumber || '');
  const customerName = escapeQueryString(input.customerName || '');

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QBO_ID_RE = /^\d+$/;

// Search results stay small: full records come from getEntityDetail.
function compactRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const party = record.CustomerRef || record.VendorRef || record.EntityRef || record.EmployeeRef;
  const summary = {
    id: record.Id,
    name: record.DisplayName || record.FullyQualifiedName || record.Name,
    docNumber: record.DocNumber,
    kind: record.AccountType || record.Type || record.PaymentType || record.PayType,
    subType: record.AccountSubType,
    txnDate: record.TxnDate,
    totalAmt: record.TotalAmt ?? record.Amount,
    balance: record.Balance ?? record.CurrentBalance,
    party: party ? { id: party.value, name: party.name, ...(party.type ? { type: party.type } : {}) } : undefined,
    from: record.FromAccountRef?.name,
    to: record.ToAccountRef?.name,
    unitPrice: record.UnitPrice,
    qtyOnHand: record.QtyOnHand,
    taxable: record.Taxable,
    rateValue: record.RateValue,
    active: record.Active,
    privateNote: typeof record.PrivateNote === 'string' ? record.PrivateNote.slice(0, 200) : undefined,
    updated: record.MetaData?.LastUpdatedTime,
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

async function readSingleton(type, qbo) {
  const result = await qbo.query(`SELECT * FROM ${type}`);
  return result?.QueryResponse?.[type]?.[0] || null;
}

// Builds WHERE conditions from the structured filters. Values are validated or
// escaped here; the model never supplies query syntax.
function searchConditions(type, filters) {
  if (filters === undefined || filters === null) return { conditions: [] };
  if (typeof filters !== 'object' || Array.isArray(filters)) return { error: 'filters must be an object' };
  const isList = LIST_TYPES.includes(type);
  const conditions = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    const onlyFor = (allowed, label) => (allowed ? null : `The ${key} filter applies to ${label} only, not ${type}.`);
    let problem = null;
    if (key === 'active') {
      problem = onlyFor(isList, 'lists') || (['active', 'inactive', 'all'].includes(value) ? null : 'active must be active, inactive or all');
      if (!problem) conditions.push(value === 'all' ? 'Active IN (true, false)' : `Active = ${value === 'active'}`);
    } else if (key === 'accountType') {
      problem = onlyFor(type === 'Account', 'Account') || (ACCOUNT_TYPES.includes(value) ? null : `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`);
      if (!problem) conditions.push(`AccountType = '${value}'`);
    } else if (key === 'itemType') {
      problem = onlyFor(type === 'Item', 'Item') || (ITEM_TYPES.includes(value) ? null : `itemType must be one of: ${ITEM_TYPES.join(', ')}`);
      if (!problem) conditions.push(`Type = '${value}'`);
    } else if (key === 'txnDateFrom' || key === 'txnDateTo') {
      problem = onlyFor(!isList, 'transactions') || (DATE_RE.test(String(value)) ? null : `${key} must be YYYY-MM-DD`);
      if (!problem) conditions.push(`TxnDate ${key === 'txnDateFrom' ? '>=' : '<='} '${value}'`);
    } else if (key === 'customerId' || key === 'vendorId') {
      const allowed = key === 'customerId' ? CUSTOMER_TXN_TYPES : VENDOR_TXN_TYPES;
      problem = onlyFor(allowed.includes(type), allowed.join(', ')) || (QBO_ID_RE.test(String(value)) ? null : `${key} must be a QBO Id`);
      if (!problem) conditions.push(`${key === 'customerId' ? 'CustomerRef' : 'VendorRef'} = '${value}'`);
    } else {
      problem = `Unsupported filter ${String(key).slice(0, 40)}. Use active, accountType, itemType, txnDateFrom, txnDateTo, customerId or vendorId.`;
    }
    if (problem) return { error: problem };
  }
  return { conditions };
}

async function handleSearchEntities(input, context) {
  const { type } = input;
  const query = escapeQueryString(input.query);
  const limit = Math.min(Math.max(Math.floor(Number(input.limit)) || 10, 1), 100);
  const startPosition = Math.max(Math.floor(Number(input.startPosition)) || 1, 1);

  if (!VALID_ENTITY_TYPES.includes(type)) {
    return {
      success: false,
      error: `Invalid entity type "${type}". Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    };
  }

  if (SINGLETON_TYPES.includes(type)) {
    const record = await readSingleton(type, context.qbo);
    return { success: true, data: { type, count: record ? 1 : 0, records: record ? [record] : [] } };
  }

  const { conditions, error } = searchConditions(type, input.filters);
  if (error) return { success: false, error };
  if (query && !UNSEARCHABLE_TEXT_TYPES.includes(type)) {
    // People use DisplayName; lists (items, accounts, terms...) use Name; transactions use DocNumber
    const field = PEOPLE_TYPES.includes(type) ? 'DisplayName' : NAME_SEARCH_TYPES.includes(type) ? 'Name' : 'DocNumber';
    conditions.unshift(`${field} LIKE '%${query}%'`);
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const sortable = !LIST_TYPES.includes(type) || SORTABLE_LIST_TYPES.includes(type);
  // One extra row shows whether another page exists.
  const page = `${startPosition > 1 ? ` STARTPOSITION ${startPosition}` : ''} MAXRESULTS ${limit + 1}`;
  let ordered = sortable;
  let result;
  try {
    result = await context.qbo.query(`SELECT * FROM ${type}${where}${sortable ? ' ORDERBY MetaData.LastUpdatedTime DESC' : ''}${page}`);
  } catch (err) {
    // A type QuickBooks will not sort this way still answers unsorted.
    if (!sortable || Number(err?.status) !== 400) throw err;
    ordered = false;
    result = await context.qbo.query(`SELECT * FROM ${type}${where}${page}`);
  }
  const rows = result?.QueryResponse?.[type] || [];
  const records = rows.slice(0, limit).map(compactRecord);
  const more = rows.length > limit;

  return {
    success: true,
    data: {
      type,
      count: records.length,
      startPosition,
      order: ordered ? 'most recently updated first' : 'as returned by QuickBooks',
      nextStartPosition: more ? startPosition + limit : null,
      records,
    },
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

  if (SINGLETON_TYPES.includes(type)) {
    const record = await readSingleton(type, context.qbo);
    if (!record) return { success: false, error: `QuickBooks returned no ${type} record.` };
    return { success: true, data: { type, id: record.Id ?? null, record } };
  }

  if (!/^\d+$/.test(String(id))) {
    return { success: false, error: `Invalid ${type} Id: ${String(id).slice(0, 40)}` };
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

  if (!VALID_ENTITY_TYPES.includes(entityType) || SINGLETON_TYPES.includes(entityType)) {
    return {
      success: false,
      error: `Invalid entity type "${entityType}". Must be one of: ${VALID_ENTITY_TYPES.filter((t) => !SINGLETON_TYPES.includes(t)).join(', ')}`,
    };
  }

  if (!/^\d+$/.test(String(entityId))) {
    return { success: false, error: `Invalid ${entityType} Id: ${String(entityId).slice(0, 40)}` };
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

function recordSummary(entityType, record) {
  if (!record) return { entityType };
  return {
    entityType,
    id: record.Id,
    docNumber: record.DocNumber,
    name: record.DisplayName || record.Name || record.FullyQualifiedName,
    totalAmt: record.TotalAmt,
    balance: record.Balance,
    txnDate: record.TxnDate,
    privateNote: record.PrivateNote,
  };
}

function checkWritable(entityType, allowed = WRITABLE_ENTITY_TYPES, id) {
  if (!allowed.includes(entityType)) {
    return { success: false, error: `Unsupported entity type: ${entityType}. Allowed: ${allowed.join(', ')}` };
  }
  // QBO Ids are numeric; anything else could alter the request path.
  if (id !== undefined && !/^\d+$/.test(String(id))) {
    return { success: false, error: `Invalid ${entityType} Id: ${String(id).slice(0, 40)}` };
  }
  return null;
}

// Models sometimes wrap a body as { Invoice: {...} }, the shape QBO responds with.
function unwrapBody(entityType, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const keys = Object.keys(body);
  const inner = body[entityType];
  return keys.length === 1 && keys[0] === entityType && inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : body;
}

// A sparse update still replaces the whole Line list, so lines left out are
// deleted. Refuse that unless the caller said the list is complete.
function checkLineReplacement(entityType, current, changes, replaceAll) {
  if (!Object.prototype.hasOwnProperty.call(changes, 'Line')) return null;
  if (!Array.isArray(changes.Line)) return 'Line must be a list of lines.';
  // QuickBooks recalculates subtotal lines itself.
  const existing = (Array.isArray(current.Line) ? current.Line : []).filter((line) => line && line.DetailType !== 'SubTotalLineDetail');
  const existingIds = existing.map((line) => line.Id).filter((lineId) => lineId !== undefined && lineId !== null).map(String);
  const sentIds = changes.Line.map((line) => line?.Id).filter((lineId) => lineId !== undefined && lineId !== null).map(String);
  const unknown = sentIds.filter((lineId) => !existingIds.includes(lineId));
  if (unknown.length) {
    return `Line Id ${unknown.join(', ')} is not on ${entityType} ${current.Id}. Leave Id off new lines, and read the record for its current line Ids.`;
  }
  if (!existing.length || replaceAll) return null;
  if (existingIds.length < existing.length) {
    return `Sending Line replaces every line on ${entityType} ${current.Id}, and its existing lines have no Ids to keep them by. `
      + 'Send the complete list of lines it should have and set replaceAllLines: true.';
  }
  const dropped = existingIds.filter((lineId) => !sentIds.includes(lineId));
  if (dropped.length) {
    return `This change would remove line Id ${dropped.join(', ')} from ${entityType} ${current.Id}, because sending Line replaces the whole list. `
      + 'Include every existing line (with its Id) you want to keep, or set replaceAllLines: true to remove the others.';
  }
  return null;
}

async function handleCreateRecord(input, context) {
  const { entityType } = input;
  const record = unwrapBody(entityType, input.record);
  const invalid = checkWritable(entityType);
  if (invalid) return invalid;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { success: false, error: 'record must be an object in QBO API shape' };
  }
  // QBO treats a body with Id/SyncToken as an update (a full overwrite without
  // sparse), so a "create" must never carry them. Edits go through updateRecord.
  const updateFields = ['Id', 'SyncToken', 'sparse'].filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (updateFields.length) {
    return { success: false, error: `createRecord cannot include ${updateFields.join(', ')}. Use updateRecord to change an existing record.` };
  }
  const result = await context.qbo.create(entityType.toLowerCase(), record);
  return { success: true, data: recordSummary(entityType, result[entityType]) };
}

async function handleUpdateRecord(input, context) {
  const { entityType, id } = input;
  const invalid = checkWritable(entityType, WRITABLE_ENTITY_TYPES, id ?? '');
  if (invalid) return invalid;
  const unwrapped = unwrapBody(entityType, input.changes);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
    return { success: false, error: 'changes must be an object in QBO API shape' };
  }
  // The flag is ours, never a QuickBooks field.
  const { replaceAllLines: nestedFlag, ...changes } = unwrapped;
  const replaceAll = input.replaceAllLines === true || nestedFlag === true;
  const entity = entityType.toLowerCase();
  const current = (await context.qbo.read(entity, id))[entityType];
  if (!current) return { success: false, error: `${entityType} ${id} was not found` };
  const lineProblem = checkLineReplacement(entityType, current, changes, replaceAll);
  if (lineProblem) return { success: false, error: lineProblem };
  const result = await context.qbo.update(entity, {
    ...changes,
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
  });
  return { success: true, data: recordSummary(entityType, result[entityType]) };
}

async function handleVoidTransaction(input, context) {
  const { entityType, id } = input;
  const invalid = checkWritable(entityType, VOIDABLE_ENTITY_TYPES, id ?? '');
  if (invalid) return invalid;
  const entity = entityType.toLowerCase();
  const current = (await context.qbo.read(entity, id))[entityType];
  if (!current) return { success: false, error: `${entityType} ${id} was not found` };
  const body = { Id: current.Id, SyncToken: current.SyncToken };
  // QBO voids payments and bill payments through a sparse update with
  // include=void; invoices and sales receipts use operation=void.
  const result = ['Payment', 'BillPayment'].includes(entityType)
    ? await context.qbo.apiCall('POST', `${entity}?operation=update&include=void`, { ...body, sparse: true })
    : await context.qbo.apiCall('POST', `${entity}?operation=void`, body);
  return { success: true, data: recordSummary(entityType, result[entityType] || current) };
}

async function handleGetCoverage(input, context) {
  // Required here, not at the top: coverage reads WRITABLE_ENTITY_TYPES from this module.
  const coverage = require('./coverage');
  const result = await coverage.getCoverage(context.qbo, context.realmId, { refresh: input.refresh === true });
  const area = input.area ? String(input.area) : null;
  if (area && !result.areas.some((a) => a.key === area)) {
    return { success: false, error: `Unknown area ${area}. Known areas: ${result.areas.map((a) => a.key).join(', ')}` };
  }
  return {
    success: true,
    data: {
      checkedAt: result.checkedAt,
      summary: coverage.summarizeForAssistant(result, { areaKey: area }),
      areas: result.areas
        .filter((a) => !area || a.key === area)
        .map(({ key, name, status, signals }) => ({ key, name, status, signals })),
    },
  };
}

function reportCells(cols) {
  return (cols || []).map((c) => (c?.value ?? '')).join(' | ');
}

function flattenReportRows(rows, depth, out) {
  for (const row of rows || []) {
    if (out.lines.length >= REPORT_MAX_LINES) { out.truncated = true; return; }
    const pad = '  '.repeat(depth);
    if (row.Header?.ColData) out.lines.push(pad + reportCells(row.Header.ColData));
    if (row.ColData) { out.lines.push(pad + reportCells(row.ColData)); out.dataRows += 1; }
    if (row.Rows?.Row) flattenReportRows(row.Rows.Row, depth + 1, out);
    if (row.Summary?.ColData) out.lines.push(pad + reportCells(row.Summary.ColData));
  }
}

async function handleRunReport(input, context) {
  const { report } = input;
  if (!REPORT_NAMES.includes(report)) {
    return { success: false, error: `Unknown report. Use one of: ${REPORT_NAMES.join(', ')}` };
  }
  const params = new URLSearchParams();
  for (const [field, param] of [['startDate', 'start_date'], ['endDate', 'end_date'], ['reportDate', 'report_date']]) {
    if (input[field] == null) continue;
    if (!DATE_RE.test(String(input[field]))) return { success: false, error: `${field} must be YYYY-MM-DD` };
    params.set(param, input[field]);
  }
  if (['Accrual', 'Cash'].includes(input.accountingMethod)) params.set('accounting_method', input.accountingMethod);
  if (typeof input.summarizeColumnBy === 'string' && /^[A-Za-z]+$/.test(input.summarizeColumnBy)) {
    params.set('summarize_column_by', input.summarizeColumnBy);
  }
  for (const [field, param] of REPORT_ID_FILTERS) {
    if (input[field] == null || input[field] === '') continue;
    const ids = String(input[field]).replace(/\s+/g, '');
    if (!/^\d+(,\d+){0,19}$/.test(ids)) return { success: false, error: `${field} must be a QBO Id or up to 20 comma-separated Ids` };
    params.set(param, ids);
  }
  const offset = Math.max(Math.floor(Number(input.rowOffset)) || 0, 0);
  const limit = Math.min(Math.max(Math.floor(Number(input.rowLimit)) || REPORT_PAGE_LINES, 1), REPORT_MAX_PAGE_LINES);
  const query = params.toString();
  const result = await context.qbo.apiCall('GET', `reports/${report}${query ? `?${query}` : ''}`);
  const header = result?.Header || {};
  const noData = (header.Option || []).some((o) => o.Name === 'NoReportData' && String(o.Value) === 'true');
  const out = { lines: [], dataRows: 0, truncated: false };
  flattenReportRows(result?.Rows?.Row, 0, out);
  const lines = out.lines.slice(offset, offset + limit);
  const nextOffset = offset + limit < out.lines.length ? offset + limit : null;
  return {
    success: true,
    data: {
      report: header.ReportName || report,
      period: [header.StartPeriod, header.EndPeriod].filter(Boolean).join(' to ') || null,
      basis: header.ReportBasis || null,
      columns: (result?.Columns?.Column || []).map((c) => c.ColTitle || c.ColType || ''),
      empty: noData || out.dataRows === 0,
      dataRows: out.dataRows,
      totalLines: out.lines.length,
      offset,
      lines,
      nextOffset,
      // More lines exist after this page, or the report exceeded what is kept.
      truncated: nextOffset !== null || out.truncated,
    },
  };
}

const toolHandlers = {
  lookupCustomer: handleLookupCustomer,
  lookupInvoice: handleLookupInvoice,
  searchEntities: handleSearchEntities,
  getEntityDetail: handleGetEntityDetail,
  getTransactionChain: handleGetTransactionChain,
  getChangeSummary: handleGetChangeSummary,
  getCoverage: handleGetCoverage,
  runReport: handleRunReport,
  createInvoice: handleCreateInvoice,
  applyPayment: handleApplyPayment,
  createBill: handleCreateBill,
  applyBillPayment: handleApplyBillPayment,
  runIssuePack: handleRunIssuePack,
  createCheckpoint: handleCreateCheckpoint,
  createRecord: handleCreateRecord,
  updateRecord: handleUpdateRecord,
  voidTransaction: handleVoidTransaction,
};

const toolPermissions = {
  lookupCustomer: 'auto',
  lookupInvoice: 'auto',
  searchEntities: 'auto',
  getEntityDetail: 'auto',
  getTransactionChain: 'auto',
  getChangeSummary: 'auto',
  getCoverage: 'auto',
  runReport: 'auto',
  createInvoice: 'confirm',
  applyPayment: 'confirm',
  createBill: 'confirm',
  applyBillPayment: 'confirm',
  runIssuePack: 'confirm',
  createCheckpoint: 'confirm',
  createRecord: 'confirm',
  updateRecord: 'confirm',
  voidTransaction: 'confirm',
};

module.exports = {
  toolDefinitions,
  toolHandlers,
  toolPermissions,
  VALID_ENTITY_TYPES,
  WRITABLE_ENTITY_TYPES,
  VOIDABLE_ENTITY_TYPES,
  SINGLETON_TYPES,
  escapeQueryString,
  unwrapBody,
  recordSummary,
};
