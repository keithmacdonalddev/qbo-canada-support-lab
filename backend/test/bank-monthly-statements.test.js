'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  root = path.resolve(__dirname, '../..');
const C = require(path.join(root, 'backend/src/modules/bank-settlement-contract')),
  M = require(path.join(root, 'backend/src/modules/bank-monthly-statement-service')),
  P = require(path.join(root, 'backend/src/modules/bank-statement-package')),
  PDF = require(path.join(root, 'backend/src/modules/bank-statement-pdf'));
const scope = {
    environment: 'sandbox',
    realmId: '123',
    connectionId: 'a'.repeat(24)
  },
  ownerId = 'b'.repeat(24),
  bound = {
    scope,
    ownerId,
    actorId: ownerId
  };
function ledger(epoch = '2026-11-01T12:00:00Z', through = '2026-10', card = false) {
  const l = {
    version: 1,
    scope,
    ledgerId: 'fixture-bank',
    account: {
      accountId: '50',
      accountCurrency: 'CAD',
      accountType: card ? 'Credit Card' : 'Bank',
      accountName: 'Fictional bank',
      balanceConvention: card ? 'card-amount-owed' : 'bank-balance'
    },
    openingMinor: 10000,
    openingPeriod: through,
    throughPeriod: through,
    events: [],
    packages: [],
    balance: {
      openingMinor: 10000,
      movementMinor: 0,
      balanceMinor: 10000,
      pendingCount: 0,
      pendingNativeMinor: 0,
      postedCount: 0,
      reversedCount: 0
    }
  };
  l.contentHash = C.hash(l);
  l.adoption = {
    ownerId,
    actorId: ownerId,
    at: epoch
  };
  return l;
}
test('complete-month readiness exposes current epoch and historical gaps without inventing quiet months', () => {
  const g = new Map();
  assert.match(M.readiness(ledger('2026-11-04T12:00:00Z'), g, '2026-12-01').blockers[0], /2026-11-01/);
  assert.match(M.readiness(ledger('2026-11-04T12:00:00Z', '2023-09'), g, '2026-12-01').blockers[0], /2023-10-01/);
  const r = M.readiness(ledger(), g, '2026-12-01');
  assert.equal(r.due, true);
  assert.deepEqual(r.blockers, []);
  assert.equal(M.readiness(ledger(), g, '2026-11-30').due, false);
});
test('owner list is scoped, bounded and reports exact non-due/coverage hold with no artifacts or financial actions', async () => {
  let calls = 0;
  const l = ledger('2026-11-04T12:00:00Z'),
    store = {
      getLedger: async () => ({
        ...scope,
        _id: C.hash({
          scope,
          kind: 'ledger-account',
          accountId: '50'
        }),
        kind: 'ledger-account',
        eventId: '@ledger:50',
        revision: 0,
        accountId: '50',
        accountCurrency: 'CAD',
        sourceHash: l.contentHash,
        contentHash: l.contentHash,
        payload: l
      }),
      listMonthlyRows: async () => []
    },
    api = M.createBankMonthlyStatementService({
      store,
      artifacts: {
        write: () => {
          throw Error('No writes');
        }
      },
      authorize: async b => {
        assert.deepEqual(b, bound);
        calls++;
      },
      loadActivity: () => {
        throw Error('No full source before eligible due month');
      },
      loadDeliveryProof: () => {
        throw Error('No delivery read before eligible due month');
      },
      authenticateBaseline: () => {
        throw Error('No artifact read before eligible due month');
      },
      now: () => Date.parse('2026-11-04T20:00:00Z')
    });
  const list = await api.list(bound, '50');
  assert.equal(list.qboCalls, 0);
  assert.equal(list.readiness.status, 'held');
  assert.equal(list.readiness.due, false);
  assert.equal(list.total, 0);
  assert.equal(calls, 1);
});
test('future-only PDF wraps the complete long opening basis while historical v1 bytes remain identical', () => {
  const basis = 'Exact opening supported by retained predecessor evidence. ' + 'Every complete word remains visible in the future monthly opening explanation. '.repeat(8),
    legacy = {
      scope,
      accountId: '50',
      accountCurrency: 'CAD',
      accountName: 'Fictional bank',
      balanceConvention: 'bank-balance',
      period: '2026-11',
      openingMinor: 10000,
      closingMinor: 10000,
      openingBasis: basis,
      events: []
    };
  assert.equal(require('node:crypto').createHash('sha256').update(PDF.generateBankStatementPdf(legacy).bytes).digest('hex'), '3be0ec2f42f71efe844f93864704a8789b7728ad8f51c4ef5929e5a41f4745bf');
  const l = ledger(),
    r = M.readiness(l, new Map(), '2026-12-01'),
    plan = M.freezePlan({
      bound,
      ledger: l,
      current: {
        rows: []
      },
      readiness: r,
      queue: {
        pending: [],
        queueHash: C.hash([])
      },
      deliveryHash: C.hash([])
    });
  plan.openingBasis = basis;
  const a = P.generateIndependentBankStatementPackage(plan),
    b = P.generateIndependentBankStatementPackage(plan);
  assert.equal(a.model.rows.length, 0);
  assert.equal(a.manifest.statementTotals.openingMinor, a.manifest.statementTotals.closingMinor);
  assert.equal(a.artifacts.some(f => f.kind === 'csv'), false);
  assert.deepEqual(a.artifacts.map(f => f.sha256), b.artifacts.map(f => f.sha256));
  const text = [...a.artifacts.find(f => f.kind === 'statement').bytes.toString().matchAll(/\(([^()]*)\) Tj/g)].map(m => m[1]).join(' ');
  assert.ok(text.includes(basis.trim()));
});
