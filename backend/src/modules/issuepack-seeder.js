const IssuePack = require('../models/IssuePack');

const BUILT_IN_PACKS = [
  {
    slug: 'ar-mismatch',
    name: 'AR Payment Mismatch',
    description: 'Creates an invoice and applies a payment for the wrong amount (off by $0.01), leaving an unexplained balance difference.',
    category: 'ar',
    severity: 'medium',
    prerequisites: [
      { entity: 'Customer', condition: 'At least 1 seeded customer' },
      { entity: 'Item', condition: 'At least 1 seeded service item' },
    ],
    mutations: [
      { step: 1, entity: 'Invoice', action: 'create', params: { amount: 1500 } },
      { step: 2, entity: 'Payment', action: 'create', params: { amount: 1500.01, note: 'Overpay by $0.01' } },
    ],
    expectedSymptoms: [
      'Invoice shows a small credit balance',
      'Customer balance does not reconcile to zero',
      'AR aging report shows a negative line item',
    ],
    investigationHints: [
      'Compare Payment.TotalAmt against Invoice.TotalAmt',
      'Check the customer balance in the Customer detail',
      'Run an AR aging report filtered to this customer',
    ],
  },
  {
    slug: 'duplicate-payment',
    name: 'Duplicate Vendor Payment',
    description: 'Creates a bill, pays it with a bill payment, then creates a second payment via a direct check for the same amount to the same vendor.',
    category: 'ap',
    severity: 'high',
    prerequisites: [
      { entity: 'Vendor', condition: 'At least 1 seeded vendor' },
      { entity: 'Account', condition: 'Expense and Bank accounts available' },
    ],
    mutations: [
      { step: 1, entity: 'Bill', action: 'create', params: { amount: 2000 } },
      { step: 2, entity: 'BillPayment', action: 'create', params: { amount: 2000 } },
      { step: 3, entity: 'Purchase', action: 'create', params: { amount: 2000, note: 'Duplicate check' } },
    ],
    expectedSymptoms: [
      'Vendor was paid twice for the same bill',
      'Bank account shows two withdrawals for the same amount',
      'AP aging shows the bill as paid but expenses are doubled',
    ],
    investigationHints: [
      'Search for all transactions to this vendor in the date range',
      'Compare BillPayment and Purchase amounts',
      'Check the bank register for duplicate amounts',
    ],
  },
  {
    slug: 'tax-code-inconsistency',
    name: 'Tax Code Inconsistency',
    description: 'Creates two invoices for the same customer and item, but with different tax codes (TAX vs NON), creating a reporting discrepancy.',
    category: 'tax',
    severity: 'medium',
    prerequisites: [
      { entity: 'Customer', condition: 'At least 1 seeded customer' },
      { entity: 'Item', condition: 'At least 1 seeded service item' },
    ],
    mutations: [
      { step: 1, entity: 'Invoice', action: 'create', params: { taxCode: 'TAX' } },
      { step: 2, entity: 'Invoice', action: 'create', params: { taxCode: 'NON' } },
    ],
    expectedSymptoms: [
      'Same item appears with different tax treatments',
      'Tax liability report may understate collected tax',
      'Customer invoices show inconsistent tax lines',
    ],
    investigationHints: [
      'Compare TaxCodeRef on line items across invoices for this customer',
      'Run a Tax Summary report and look for the item',
      'Check if the item has a default tax code that was overridden',
    ],
  },
  {
    slug: 'unapplied-credit',
    name: 'Unapplied Customer Credit',
    description: 'Creates a credit memo that is not linked to any outstanding invoice, alongside an invoice that should have received the credit.',
    category: 'ar',
    severity: 'low',
    prerequisites: [
      { entity: 'Customer', condition: 'At least 1 seeded customer' },
      { entity: 'Item', condition: 'At least 1 seeded service item' },
    ],
    mutations: [
      { step: 1, entity: 'CreditMemo', action: 'create', params: { amount: 350 } },
      { step: 2, entity: 'Invoice', action: 'create', params: { amount: 500, note: 'Outstanding — credit should apply' } },
    ],
    expectedSymptoms: [
      'Customer has an unapplied credit on their account',
      'Outstanding invoice balance is higher than it should be',
      'AR aging shows both a credit and an open invoice for the same customer',
    ],
    investigationHints: [
      'Check CreditMemo.LinkedTxn — it should be empty',
      'Look at the customer balance detail for unapplied credits',
      'The credit memo and invoice are for the same customer',
    ],
  },
  {
    slug: 'orphaned-payment',
    name: 'Orphaned Payment',
    description: 'Creates a customer payment that is not linked to any invoice, appearing as an unapplied/orphaned payment.',
    category: 'data_hygiene',
    severity: 'low',
    prerequisites: [
      { entity: 'Customer', condition: 'At least 1 seeded customer' },
    ],
    mutations: [
      { step: 1, entity: 'Payment', action: 'create', params: { amount: 750, note: 'No linked invoice' } },
    ],
    expectedSymptoms: [
      'Payment appears in customer record with no applied invoice',
      'Customer has an unapplied payment balance',
      'Open invoices report does not reflect this payment',
    ],
    investigationHints: [
      'Read the Payment and check for empty Line/LinkedTxn arrays',
      'Look at the customer balance — the payment shows as unapplied',
      'Search for recent invoices for this customer that might match',
    ],
  },
];

/**
 * Seed built-in issue packs on startup (upsert by slug).
 */
async function seedIssuePacks() {
  for (const pack of BUILT_IN_PACKS) {
    await IssuePack.findOneAndUpdate(
      { slug: pack.slug },
      { $set: pack },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
  console.log(`[issuepack-seeder] ${BUILT_IN_PACKS.length} built-in packs seeded`);
}

module.exports = { seedIssuePacks };
