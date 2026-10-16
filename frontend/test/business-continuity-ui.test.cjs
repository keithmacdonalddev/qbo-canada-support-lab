'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const { proposalView } = require('../../backend/src/modules/blueprint-draft');
const dist = path.resolve(__dirname, '../dist'), artifacts = path.resolve(__dirname, '../../artifacts/intent-ui');
test('desktop future business change binds visible dates, retains exact retries and distinguishes withdrawal from applied work', { timeout: 90000 }, async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const server = http.createServer(async (req, res) => { try { const pathname = new URL(req.url, 'http://fixture').pathname, file = pathname.startsWith('/assets/') ? path.resolve(dist, '.' + pathname) : path.join(dist, 'index.html'); if (!file.startsWith(dist + path.sep)) throw Error('Outside fixture'); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await fs.readFile(file)); } catch { res.statusCode = 404; res.end('Fixture asset unavailable'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let browser, page;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('token', 'isolated-continuity-fixture'));
    page = await context.newPage(); const origin = 'http://127.0.0.1:' + server.address().port, escaped = [], errors = [], writes = [];
    const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, actorId = 'b'.repeat(24), proposal = proposalView(), savedKey = ['business-continuity-v1', actorId, scope.environment, scope.realmId, scope.connectionId].join(':');
    let draft = { ...proposal, id: 'd'.repeat(24), contentHash: 'd'.repeat(64), version: 2, connectionMatches: true }, head = '1'.repeat(64), publishedBlueprint = '2'.repeat(64), owner = true, applyMode = 'lost-applied', wrongScope = false, terminal = null;
    draft.business = { ...draft.business, displayName: 'Fixture Harbour revised', openingDate: '2026-10-01', volumeProfile: 'flagship' };
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()); if (url.origin !== origin) { escaped.push(url.origin); return route.abort(); } if (!url.pathname.startsWith('/api/')) return route.continue();
      const key = url.pathname.slice(5), bodyIn = request.method() === 'POST' ? request.postDataJSON() : null; if (bodyIn) writes.push({ key, body: bodyIn }); let status = 200, body;
      const receipt = requestBody => ({ ...scope, applied: true, authorityHash: head, reviewHash: requestBody.reviewHash, effectiveFrom: requestBody.effectiveFrom, current: true, qboWrites: 0 });
      if (key === 'auth/me') body = { user: { id: actorId, displayName: 'Fixture owner', role: 'agent' } };
      else if (key === 'qbo/status') body = { connected: true, status: 'active', ...scope, companyName: 'Fixture Harbour Business' };
      else if (key === 'company/business-plan') body = { data: { ...scope, draft, proposal, mappingDefinitions: {}, storage: { ready: true }, canSave: false, permissionToSave: false, activationNeeds: [] } };
      else if (key === 'company/business-governance') body = { data: { ...scope, owner, companyName: 'Fixture Harbour Business', published: { version: head.startsWith('1') ? 1 : 2, contentHash: head, blueprintHash: publishedBlueprint, scope, openingDate: '2026-10-01' }, calendar: { openingDate: '2026-10-01', verifiedThrough: '2026-10-15', revision: 1, currentOperationId: null, completionPending: false }, pendingOperations: [], canReviseBeforeActivity: false, limitation: 'Historical managed evidence is retained; reconciliation remains separate.' } };
      else if (key === 'company/business-governance/continuity/review') {
        body = { data: { ...scope, reviewHash: '4'.repeat(64), review: { version: 1, scope: wrongScope ? { ...scope, realmId: '999' } : scope, previousAuthorityHash: head, ...bodyIn, verifiedThrough: '2026-10-15', changes: { displayName: { from: 'Fixture Harbour original', to: draft.business.displayName }, volumeProfile: { from: 'development', to: draft.business.volumeProfile }, historicalMonths: { from: 36, to: 36 }, addedMasterRoles: [{ key: 'field-client-005', entity: 'Customer', id: '105', name: 'Fixture Willow Services' }, { key: 'care-client-006', entity: 'Customer', id: '106', name: 'Fixture Seaside Care' }] } } } };
      } else if (key === 'company/business-governance/continuity') {
        if (terminal && JSON.stringify(terminal.request) === JSON.stringify(bodyIn)) body = { data: terminal.response };
        else if (applyMode === 'lost-applied') { head = '3'.repeat(64); publishedBlueprint = bodyIn.blueprintHash; terminal = { request: bodyIn, response: receipt(bodyIn) }; status = 503; body = { error: 'Fixture lost business-change acknowledgement.' }; }
        else { status = 503; body = { error: 'Fixture could not confirm this pending request.' }; }
      } else if (key === 'company/business-governance/continuity/withdraw') {
        if (terminal && JSON.stringify(terminal.request) === JSON.stringify(bodyIn.request)) body = { data: terminal.response };
        else { terminal = { request: bodyIn.request, response: { ...scope, applied: false, withdrawn: true, withdrawalHash: '6'.repeat(64), reviewHash: bodyIn.request.reviewHash, effectiveFrom: bodyIn.request.effectiveFrom, qboWrites: 0 } }; body = { data: terminal.response }; }
      } else { status = 503; body = { error: 'Panel outside the isolated continuity workflow.' }; }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin + '/company'); const panel = page.getByRole('region', { name: 'Future business changes', exact: true });
    await panel.getByRole('button', { name: 'Review future business change', exact: true }).waitFor(); assert.equal(writes.length, 0);
    await panel.getByLabel('New activity starts on', { exact: true }).evaluate(input => { input.value = '2026-10-16'; });
    await panel.getByRole('button', { name: 'Review future business change', exact: true }).focus(); await page.keyboard.press('Enter'); await panel.getByRole('heading', { name: 'Review the change from 2026-10-16', exact: true }).waitFor();
    assert.equal(writes[0].body.effectiveFrom, '2026-10-16'); assert.equal(await panel.getByRole('button', { name: 'Apply reviewed business change', exact: true }).isDisabled(), true);
    await panel.getByLabel('New activity starts on', { exact: true }).evaluate(input => { input.value = '2026-10-17'; });
    await panel.getByLabel('Reason for the business change', { exact: true }).fill('Owner reviewed the new scale while retaining every earlier obligation.'); await panel.getByLabel(/I reviewed this change/).check(); await panel.getByRole('button', { name: 'Apply reviewed business change', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'The draft or date changed.' }).waitFor(); assert.equal(writes.filter(row => row.key === 'company/business-governance/continuity').length, 0);
    await panel.getByRole('button', { name: 'Review future business change', exact: true }).click(); await panel.getByRole('heading', { name: 'Review the change from 2026-10-17', exact: true }).waitFor(); await panel.getByLabel(/I reviewed this change/).check(); await panel.getByText('Fixture Willow Services', { exact: false }).waitFor(); await panel.evaluate(node => node.scrollIntoView({ block: 'center' })); await page.screenshot({ path: path.join(artifacts, 'business-continuity-review.png') });
    await panel.getByRole('button', { name: 'Apply reviewed business change', exact: true }).click(); await panel.getByRole('alert').filter({ hasText: 'Fixture lost business-change acknowledgement.' }).waitFor();
    const first = writes.find(row => row.key === 'company/business-governance/continuity').body; assert.ok(await page.evaluate(key => sessionStorage.getItem(key), savedKey)); await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, 'business-continuity-pending.png') });
    await page.reload(); await panel.getByRole('button', { name: 'Retry saved business change', exact: true }).waitFor(); await panel.getByRole('button', { name: 'Retry saved business change', exact: true }).click(); await panel.getByRole('status').filter({ hasText: 'Business change saved.' }).waitFor();
    assert.deepEqual(writes.filter(row => row.key === 'company/business-governance/continuity').map(row => row.body), [first, first]); assert.equal(await page.evaluate(key => sessionStorage.getItem(key), savedKey), null); await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, 'business-continuity-applied.png') });
    draft = { ...draft, id: 'e'.repeat(24), contentHash: 'e'.repeat(64), version: 3, business: { ...draft.business, displayName: 'Fixture Harbour next draft' } }; applyMode = 'not-confirmed'; terminal = null;
    await page.reload(); await panel.getByLabel('New activity starts on', { exact: true }).fill('2026-10-20'); await panel.getByRole('button', { name: 'Review future business change', exact: true }).click(); await panel.getByLabel('Reason for the business change', { exact: true }).fill('Owner reviewed the next business version before deciding whether to keep it.'); await panel.getByLabel(/I reviewed this change/).check(); await panel.getByRole('button', { name: 'Apply reviewed business change', exact: true }).click(); await panel.getByRole('alert').filter({ hasText: 'Fixture could not confirm' }).waitFor();
    const beforeWithdraw = head; await panel.getByRole('button', { name: 'Withdraw pending business change', exact: true }).click(); await panel.getByRole('status').filter({ hasText: 'The pending business change was withdrawn.' }).waitFor(); assert.equal(head, beforeWithdraw); assert.equal(await page.evaluate(key => sessionStorage.getItem(key), savedKey), null); await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, 'business-continuity-withdrawn.png') });
    applyMode = 'lost-applied'; terminal = null;
    await panel.getByLabel('New activity starts on', { exact: true }).fill('2026-10-21'); await panel.getByRole('button', { name: 'Review future business change', exact: true }).click(); await panel.getByLabel(/I reviewed this change/).check(); await panel.getByRole('button', { name: 'Apply reviewed business change', exact: true }).click(); await panel.getByRole('alert').filter({ hasText: 'Fixture lost business-change acknowledgement.' }).waitFor(); await panel.getByRole('button', { name: 'Withdraw pending business change', exact: true }).click(); await panel.getByRole('status').filter({ hasText: 'Business change saved.' }).waitFor(); assert.equal(await panel.getByText(/pending business change was withdrawn/).count(), 0);
    draft = { ...draft, id: 'f'.repeat(24), contentHash: 'f'.repeat(64), version: 4 }; wrongScope = true;
    await page.reload(); await panel.getByLabel('New activity starts on', { exact: true }).fill('2026-10-22'); await panel.getByRole('button', { name: 'Review future business change', exact: true }).click(); await panel.getByRole('alert').filter({ hasText: 'The selected company changed.' }).waitFor(); assert.equal(await panel.getByRole('button', { name: 'Apply reviewed business change', exact: true }).count(), 0); await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, 'business-continuity-scope-error.png') });
    owner = false; await page.reload(); await page.getByRole('region', { name: 'Business publication and calendar' }).waitFor(); assert.equal(await page.getByRole('region', { name: 'Future business changes', exact: true }).count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(escaped, []); assert.ok(writes.every(row => row.key.startsWith('company/business-governance/continuity'))); assert.ok(writes.every(row => !Object.hasOwn(row.body, 'realmId') && !Object.hasOwn(row.body, 'ownerId')));
    await context.close();
  } catch (error) { if (page) await page.screenshot({ path: path.join(artifacts, 'business-continuity-ui-failure.png') }).catch(() => {}); throw error; }
  finally { await browser?.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});
