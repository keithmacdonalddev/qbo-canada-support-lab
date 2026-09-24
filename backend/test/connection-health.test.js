const assert = require('node:assert/strict');
const test = require('node:test');
const OAuthClient = require('intuit-oauth');
const { isAuthFailure, expireRejectedConnection, refreshTokenExpiryFrom, describeProbeFailure, describeRefreshFailure } = require('../src/modules/connection-health');
const { redactLogSecrets } = require('../src/modules/log-diagnostic');
const { QBOClient } = require('../src/modules/qbo-client');
const Connection = require('../src/models/Connection');

test('only explicit refresh authorization rejection requires reconnect', () => {
  assert.equal(isAuthFailure({ qboStage: 'refresh', error: 'invalid_grant', status: 400 }), true);
  assert.equal(isAuthFailure({ qboStage: 'refresh', originalMessage: 'invalid_grant' }), true);
  assert.equal(isAuthFailure({ qboStage: 'refresh', message: 'refresh token expired' }), true);
  assert.equal(isAuthFailure({ qboStage: 'refresh', message: 'The Refresh token is invalid, please Authorize again.' }), true);
  assert.equal(isAuthFailure({ qboStage: 'refresh', message: 'Bad Request', description: 'Refresh token revoked' }), true);
  assert.equal(isAuthFailure({ qboStage: 'refresh', status: 400, message: 'bad request' }), false);
  assert.equal(isAuthFailure({ qboStage: 'api', status: 401, message: 'invalid_token' }), false);
  assert.equal(isAuthFailure({ qboStage: 'api', status: 403, message: 'permission denied' }), false);
  assert.equal(isAuthFailure({ qboStage: 'refresh', status: 503, message: 'unavailable' }), false);
});

test('diagnostic log text preserves failure cause and redacts credential values', () => {
  const result = redactLogSecrets('OAuthError: invalid_grant token=fixture-secret https://example.test/callback?code=fixture-code');
  assert.match(result, /OAuthError: invalid_grant/);
  assert.match(result, /token=\[redacted\]/);
  assert.match(result, /code=\[redacted\]/);
  assert.doesNotMatch(result, /fixture-secret|fixture-code/);
});

test('provider trace IDs are validated before reaching logs or support UI', () => {
  const extract = QBOClient.prototype._extractIntuitTid;
  assert.equal(extract({ intuit_tid: 'fixture-tid' }), 'fixture-tid');
  assert.equal(extract({ intuit_tid: 'unsafe trace\nAuthorization: Bearer fixture' }), '');
  assert.equal(extract({ intuit_tid: 'unsafe trace' }, 'safe-fallback'), 'safe-fallback');
  assert.equal(extract(null, 'safe-fallback'), 'safe-fallback');
});

test('missing refresh lifetime stays unknown and probe failures remain actionable', () => {
  assert.equal(refreshTokenExpiryFrom({}), null);
  assert.equal(describeProbeFailure({ qboStage: 'api', status: 429 }).code, 'QBO_RATE_LIMITED');
  assert.equal(describeProbeFailure({ qboStage: 'storage_save' }).code, 'QBO_TOKEN_SAVE_FAILED');
  assert.equal(describeProbeFailure({ qboStage: 'storage_read' }).code, 'QBO_STORAGE_UNAVAILABLE');
  assert.equal(describeProbeFailure({ qboStage: 'api', status: 401 }).code, 'QBO_PERMISSION_ERROR');
  assert.equal(describeProbeFailure({ qboStage: 'refresh', error: 'invalid_grant' }).code, 'QBO_RECONNECT_REQUIRED');
});

test('saved refresh token can reach the SDK request even when old lifetime metadata is missing', async () => {
  const oauthClient = new OAuthClient({
    clientId: 'fixture-client', clientSecret: 'fixture-secret',
    environment: 'sandbox', redirectUri: 'http://localhost/fixture',
  });
  oauthClient.log = () => {};
  const client = Object.create(QBOClient.prototype);
  client.oauthClient = oauthClient;
  const connection = {
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
    tokenExpiresAt: new Date(Date.now() - 60_000),
  };
  client._adoptStoredTokens(connection);
  await assert.rejects(oauthClient.refresh(), /Refresh token is invalid/);
  let requests = 0;
  oauthClient.getTokenRequest = async (request) => {
    requests += 1;
    assert.equal(request.data.refresh_token, connection.refreshToken);
    return { json: { access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600 } };
  };
  const result = await oauthClient.refreshUsingToken(connection.refreshToken);
  assert.equal(requests, 1);
  assert.equal(result.json.refresh_token, 'next-refresh');

  client._adoptStoredTokens({ ...connection, refreshTokenExpiresAt: new Date(Date.now() + 3600_000) });
  assert.equal(oauthClient.validateToken(), true);
});

test('refresh failure distinguishes provider denial, throttling, storage and unknown causes', () => {
  const denied = describeRefreshFailure({
    qboStage: 'refresh', code: '400', error: 'Bad Request', intuit_tid: 'fixture-tid',
  });
  assert.equal(denied.code, 'QBO_REFRESH_REJECTED');
  assert.equal(denied.httpStatus, 502);
  assert.equal(denied.qboStatus, 400);
  assert.equal(denied.intuit_tid, 'fixture-tid');
  assert.equal(describeRefreshFailure({ qboStage: 'refresh', authResponse: { response: { status: 429 } } }).code, 'QBO_RATE_LIMITED');
  assert.equal(describeRefreshFailure({ qboStage: 'storage_save' }).code, 'QBO_TOKEN_SAVE_FAILED');
  assert.equal(describeRefreshFailure({ qboStage: 'storage_read' }).code, 'QBO_STORAGE_UNAVAILABLE');
  assert.match(describeRefreshFailure({ qboStage: 'storage_read' }).message, /No refresh request was sent/);
  assert.equal(describeRefreshFailure({ qboStage: 'conflict' }).code, 'QBO_CONNECTION_CHANGED');
  assert.equal(describeRefreshFailure({ qboStage: 'refresh', code: 'ETIMEDOUT' }).code, 'QBO_NETWORK_ERROR');
  assert.equal(describeRefreshFailure({ qboStage: 'refresh', originalMessage: 'connect ETIMEDOUT' }).code, 'QBO_NETWORK_ERROR');
  assert.equal(describeRefreshFailure({ qboStage: 'refresh', message: 'unknown', intuit_tid: 'bad tid with spaces' }).intuit_tid, null);
  assert.equal(describeRefreshFailure({ qboStage: 'refresh', intuitTid: 'fixture-tid' }).intuit_tid, 'fixture-tid');
});

test('failed API probe preserves status; rejected refresh expires and audits once', async () => {
  const originalFindOneAndUpdate = Connection.findOneAndUpdate;
  let saves = 0;
  const audits = [];
  const connection = {
    _id: 'fixture-connection', userId: 'fixture-user', status: 'active',
    realmId: 'fixture-realm', refreshToken: 'fixture-refresh',
  };
  Connection.findOneAndUpdate = async (filter, update) => {
    assert.equal(filter.refreshToken, 'fixture-refresh');
    assert.equal(update.$set.status, 'expired');
    saves += 1;
    return { ...connection, status: 'expired' };
  };
  const audit = async (...args) => { audits.push(args); return { id: 'fixture-audit' }; };
  try {
    assert.equal(await expireRejectedConnection(connection,
      { qboStage: 'api', status: 401 }, 'fixture-user', audit), false);
    assert.equal(connection.status, 'active');
    assert.equal(saves, 0);
    assert.equal(audits.length, 0);
    assert.equal(await expireRejectedConnection(connection,
      { qboStage: 'refresh', error: 'invalid_grant' }, 'fixture-user', audit), true);
    assert.equal(connection.status, 'expired');
    assert.equal(saves, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0][2], 'QBO authorization rejected');
    assert.deepEqual(audits[0][3].beforeState, { status: 'active' });
  } finally {
    Connection.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('failed audit leaves connection active and does not save it', async () => {
  let saves = 0;
  const connection = { status: 'active', realmId: 'fixture-realm', async save() { saves += 1; } };
  await assert.rejects(expireRejectedConnection(connection,
    { qboStage: 'refresh', error: 'invalid_grant' }, 'fixture-user', async () => null),
  /Could not audit/);
  assert.equal(connection.status, 'active');
  assert.equal(saves, 0);
});

test('QBO client labels refresh rejection separately from API rejection', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const fake = {
      apiBase: 'https://example.test/v3/company/fixture',
      _retryAfterUntil: 0, _requestLog: [], _windowMs: 60_000,
      _extractIntuitTid: () => '',
      oauthClient: { makeApiCall: async () => { throw Object.assign(new Error('API denied'), { code: '403' }); } },
      ensureFreshToken: async () => {},
    };
    await assert.rejects(QBOClient.prototype.apiCall.call(fake, 'GET', 'companyinfo/fixture'), (err) => {
      assert.equal(err.qboStage, 'api');
      assert.equal(isAuthFailure(err), false);
      return true;
    });
    fake.ensureFreshToken = async () => { throw Object.assign(new Error('invalid_grant'), { code: '400' }); };
    await assert.rejects(QBOClient.prototype.apiCall.call(fake, 'GET', 'companyinfo/fixture'), (err) => {
      assert.equal(err.qboStage, 'refresh');
      assert.equal(isAuthFailure(err), true);
      return true;
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('QBO error log omits search query values while retaining request class', async () => {
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...parts) => { logged.push(parts); };
  try {
    const fake = {
      apiBase: 'https://example.test/v3/company/fixture',
      _retryAfterUntil: 0, _requestLog: [], _windowMs: 60_000,
      _extractIntuitTid: () => '', _extractFaultMessage: () => '',
      oauthClient: { makeApiCall: async () => ({ status: 403, headers: {} }) },
      ensureFreshToken: async () => {},
    };
    await assert.rejects(QBOClient.prototype.apiCall.call(fake, 'GET',
      'query?query=SELECT%20%2A%20FROM%20Customer%20WHERE%20DisplayName%3D%27PrivateName%27'));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1].endpoint, 'query');
  assert.doesNotMatch(JSON.stringify(logged), /PrivateName/);
});

test('simultaneous requests refresh once and both use the newest saved tokens', async () => {
  const originalFindById = Connection.findById;
  const originalFindOneAndUpdate = Connection.findOneAndUpdate;
  const originalInfo = console.info;
  let refreshStarted;
  let finishRefresh;
  const started = new Promise((resolve) => { refreshStarted = resolve; });
  const gate = new Promise((resolve) => { finishRefresh = resolve; });
  let refreshCount = 0;
  let saves = 0;
  const old = {
    _id: 'fixture-connection', userId: 'fixture-user', realmId: 'fixture-realm',
    accessToken: 'old-access', refreshToken: 'old-refresh',
    tokenExpiresAt: new Date(Date.now() - 60_000), status: 'active',
  };
  let latest = { ...old };
  Connection.findById = async () => ({ ...latest });
  Connection.findOneAndUpdate = async (filter, update) => {
    assert.equal(filter.refreshToken, latest.refreshToken);
    saves += 1;
    latest = { ...latest, ...update.$set };
    return { ...latest };
  };
  console.info = () => {};
  const makeClient = () => {
    const client = Object.create(QBOClient.prototype);
    client.connection = { ...old };
    client.realmId = old.realmId;
    client.oauthClient = {
      setToken() {},
      async refreshUsingToken(token) {
        assert.equal(token, latest.refreshToken);
        refreshCount += 1;
        refreshStarted();
        await gate;
        return { json: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, x_refresh_token_expires_in: 86400 } };
      },
    };
    return client;
  };
  try {
    const first = makeClient();
    const second = makeClient();
    const firstCallerDocument = first.connection;
    const secondCallerDocument = second.connection;
    const firstCall = first.ensureFreshToken();
    await started;
    const secondCall = second.ensureFreshToken();
    finishRefresh();
    await Promise.all([firstCall, secondCall]);
    assert.equal(refreshCount, 1);
    assert.equal(saves, 1);
    assert.equal(first.connection.refreshToken, 'new-refresh');
    assert.equal(second.connection.refreshToken, 'new-refresh');
    assert.equal(firstCallerDocument.refreshToken, 'old-refresh');
    assert.equal(secondCallerDocument.refreshToken, 'old-refresh');
  } finally {
    Connection.findById = originalFindById;
    Connection.findOneAndUpdate = originalFindOneAndUpdate;
    console.info = originalInfo;
  }
});

test('a successful forced refresh can run again with the latest stored token', async () => {
  const originalFindById = Connection.findById;
  const originalFindOneAndUpdate = Connection.findOneAndUpdate;
  const originalInfo = console.info;
  let latest = {
    _id: 'repeat-refresh', userId: 'fixture-user', realmId: 'fixture-realm',
    accessToken: 'access-0', refreshToken: 'refresh-0',
    tokenExpiresAt: new Date(Date.now() + 3600_000), status: 'active',
  };
  let refreshCount = 0;
  Connection.findById = async () => ({ ...latest });
  Connection.findOneAndUpdate = async (filter, update) => {
    assert.equal(filter.refreshToken, latest.refreshToken);
    latest = { ...latest, ...update.$set };
    return { ...latest };
  };
  console.info = () => {};
  const client = Object.create(QBOClient.prototype);
  client.connection = { ...latest };
  client.realmId = latest.realmId;
  client.oauthClient = {
    setToken() {},
    async refreshUsingToken(token) {
      assert.equal(token, latest.refreshToken);
      refreshCount += 1;
      return { json: { access_token: `access-${refreshCount}`, refresh_token: `refresh-${refreshCount}`, expires_in: 3600 } };
    },
  };
  try {
    await client.ensureFreshToken({ force: true });
    await client.ensureFreshToken({ force: true });
    assert.equal(refreshCount, 2);
    assert.equal(client.connection.refreshToken, 'refresh-2');
  } finally {
    Connection.findById = originalFindById;
    Connection.findOneAndUpdate = originalFindOneAndUpdate;
    console.info = originalInfo;
  }
});

test('a rotated token is saved on the next request after a storage failure without refreshing twice', async () => {
  const originalFindById = Connection.findById;
  const originalFindOneAndUpdate = Connection.findOneAndUpdate;
  const originalError = console.error;
  const originalInfo = console.info;
  let latest = {
    _id: 'recover-refresh', userId: 'fixture-user', realmId: 'fixture-realm',
    accessToken: 'old-access', refreshToken: 'old-refresh',
    tokenExpiresAt: new Date(Date.now() + 3600_000), status: 'active',
  };
  let attempts = 0;
  let refreshCount = 0;
  Connection.findById = async () => ({ ...latest });
  Connection.findOneAndUpdate = async (filter, update) => {
    attempts += 1;
    assert.equal(filter.refreshToken, 'old-refresh');
    if (attempts === 1) throw new Error('fixture storage outage');
    latest = { ...latest, ...update.$set };
    return { ...latest };
  };
  console.error = () => {};
  console.info = () => {};
  const client = Object.create(QBOClient.prototype);
  client.connection = { ...latest };
  client.realmId = latest.realmId;
  client.oauthClient = {
    setToken() {},
    async refreshUsingToken(token) {
      assert.equal(token, 'old-refresh');
      refreshCount += 1;
      return { json: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 } };
    },
  };
  try {
    await assert.rejects(client.ensureFreshToken({ force: true }), /fixture storage outage/);
    assert.equal(latest.refreshToken, 'old-refresh');
    await client.ensureFreshToken();
    assert.equal(refreshCount, 1);
    assert.equal(attempts, 2);
    assert.equal(latest.refreshToken, 'new-refresh');
  } finally {
    Connection.findById = originalFindById;
    Connection.findOneAndUpdate = originalFindOneAndUpdate;
    console.error = originalError;
    console.info = originalInfo;
  }
});

test('storage read failure and malformed provider response keep their distinct stages', async () => {
  const originalFindById = Connection.findById;
  const originalFindOneAndUpdate = Connection.findOneAndUpdate;
  let refreshCount = 0;
  let latest = {
    _id: 'invalid-response', userId: 'fixture-user', realmId: 'fixture-realm',
    accessToken: 'old-access', refreshToken: 'old-refresh',
    tokenExpiresAt: new Date(Date.now() - 60_000), status: 'active',
  };
  const client = Object.create(QBOClient.prototype);
  client.connection = { ...latest };
  client.realmId = latest.realmId;
  client.oauthClient = {
    setToken() {},
    async refreshUsingToken() { refreshCount += 1; return { body: '{invalid json' }; },
  };
  Connection.findOneAndUpdate = async () => { throw new Error('no token write expected'); };
  try {
    Connection.findById = async () => { throw new Error('fixture database read failure'); };
    await assert.rejects(client.ensureFreshToken({ force: true }), (error) => error.qboStage === 'storage_read');
    assert.equal(refreshCount, 0);
    Connection.findById = async () => ({ ...latest });
    await assert.rejects(client.ensureFreshToken({ force: true }), (error) => error.qboStage === 'refresh_response');
    assert.equal(refreshCount, 1);
    assert.equal(latest.refreshToken, 'old-refresh');
  } finally {
    Connection.findById = originalFindById;
    Connection.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('superseded authorization cannot be marked expired', async () => {
  const originalFindOneAndUpdate = Connection.findOneAndUpdate;
  const connection = {
    _id: 'replaced-connection', userId: 'fixture-user', realmId: 'fixture-realm',
    refreshToken: 'rejected-old-token', status: 'active',
  };
  Connection.findOneAndUpdate = async (filter) => {
    assert.equal(filter.refreshToken, 'rejected-old-token');
    return null;
  };
  try {
    assert.equal(await expireRejectedConnection(connection,
      { qboStage: 'refresh', error: 'invalid_grant' }, 'fixture-user', async () => ({ id: 'audit' })), false);
    assert.equal(connection.status, 'active');
  } finally {
    Connection.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('API 401 refreshes once and retries the read without expiring the connection', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  let calls = 0;
  let forced = 0;
  const client = Object.create(QBOClient.prototype);
  client.apiBase = 'https://example.test/v3/company/fixture';
  client._retryAfterUntil = 0;
  client._requestLog = [];
  client._windowMs = 60_000;
  client._extractIntuitTid = () => '';
  client.ensureFreshToken = async (options) => { if (options?.force) forced += 1; };
  client.oauthClient = { makeApiCall: async () => ({ status: ++calls === 1 ? 401 : 200, headers: {}, json: { QueryResponse: {} } }) };
  try {
    await client.apiCall('GET', 'query?query=fixture');
    assert.equal(calls, 2);
    assert.equal(forced, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('API 401 does not retry a production write', async () => {
  const originalError = console.error;
  console.error = () => {};
  let calls = 0;
  let forced = 0;
  const client = Object.create(QBOClient.prototype);
  client._retryAfterUntil = 0;
  client._requestLog = [];
  client._windowMs = 60_000;
  client._extractIntuitTid = () => '';
  client._extractFaultMessage = () => '';
  client.ensureFreshToken = async (options) => { if (options?.force) forced += 1; };
  client.oauthClient = { makeApiCall: async () => { calls += 1; return { status: 401, headers: {} }; } };
  try {
    await assert.rejects(client.apiCall('POST', 'invoice', { fixture: true }), (error) => error.status === 401);
    assert.equal(calls, 1);
    assert.equal(forced, 0);
  } finally {
    console.error = originalError;
  }
});
