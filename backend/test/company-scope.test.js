'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { createCompanyScope, findWorkspaceOwner } = require('../src/middleware/companyScope');
const { authenticate } = require('../src/middleware/auth');
const { createAuditEntry } = require('../src/middleware/auditLogger');
const { currentActorId, runAsActor, bindActor } = require('../src/modules/actor-context');
const AuditLog = require('../src/models/AuditLog');

const OWNER = '0000000000000000000000aa';
const MEMBER = '0000000000000000000000bb';
const STRANGER = '0000000000000000000000cc';
const REALM = '9130357222392856';

function lookups({ ownActive = [OWNER], members = { [MEMBER]: [REALM] }, active = { [REALM]: OWNER }, ready = true } = {}) {
  return {
    databaseReady: () => ready,
    hasOwnActiveConnection: async (id) => ownActive.includes(id),
    memberRealms: async (id) => members[id] || [],
    activeConnectionFor: async (realms) => {
      const realm = realms.find((r) => active[r]);
      return realm ? { userId: active[realm], realmId: realm } : null;
    },
  };
}

const bearer = (id) => `Bearer ${jwt.sign({ id, email: `${id}@test.local`, role: 'agent' }, config.jwtSecret)}`;

test('a member works in the owner workspace; everyone else in their own', async () => {
  assert.equal(await findWorkspaceOwner(OWNER, lookups()), OWNER);
  assert.equal(await findWorkspaceOwner(MEMBER, lookups()), OWNER);
  assert.equal(await findWorkspaceOwner(STRANGER, lookups()), STRANGER);
  // The member's own active connection wins over the membership.
  assert.equal(await findWorkspaceOwner(MEMBER, lookups({ ownActive: [OWNER, MEMBER] })), MEMBER);
  // Nothing is shared while the owner's connection is not active, or without a database.
  assert.equal(await findWorkspaceOwner(MEMBER, lookups({ active: {} })), MEMBER);
  assert.equal(await findWorkspaceOwner(MEMBER, lookups({ ready: false })), MEMBER);
});

test('company scope sets the owner as user, keeps the actor, and authenticate keeps it', async () => {
  const scope = createCompanyScope(lookups());
  const req = { headers: { authorization: bearer(MEMBER) } };
  let actorInside = null;
  await scope(req, {}, () => {
    actorInside = currentActorId();
    authenticate(req, {}, () => {});
  });
  assert.equal(req.user.id, OWNER);
  assert.equal(req.user.actorId, MEMBER);
  assert.equal(req.user.sharedCompany, true);
  assert.equal(actorInside, MEMBER);
});

test('company scope leaves bad or missing tokens to the route authenticate', async () => {
  const scope = createCompanyScope(lookups());
  for (const authorization of [undefined, 'Bearer not-a-token']) {
    const req = { headers: { authorization } };
    let called = false;
    await scope(req, {}, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.user, undefined);
    let status = null;
    authenticate(req, { status(code) { status = code; return { json() {} }; } }, () => {});
    assert.equal(status, 401);
  }
});

test('audit entries in a shared company name the real actor', async () => {
  const original = AuditLog.create;
  const written = [];
  AuditLog.create = async (doc) => { written.push(doc); return doc; };
  try {
    const scope = createCompanyScope(lookups());
    await scope({ headers: { authorization: bearer(MEMBER) } }, {}, () => createAuditEntry(OWNER, REALM, 'AI plan approved'));
    await scope({ headers: { authorization: bearer(OWNER) } }, {}, () => createAuditEntry(OWNER, REALM, 'AI plan approved'));
    await createAuditEntry(OWNER, REALM, 'background job');
  } finally {
    AuditLog.create = original;
  }
  assert.equal(written[0].userId, OWNER);
  assert.equal(written[0].actorUserId, MEMBER);
  assert.equal(written[1].actorUserId, undefined);
  assert.equal(written[2].actorUserId, undefined);
});

test('work bound during a request keeps its actor when it runs later', async () => {
  const later = runAsActor(MEMBER, () => bindActor(() => currentActorId()));
  assert.equal(later(), MEMBER);
  assert.equal(bindActor(() => currentActorId())(), null);
});
