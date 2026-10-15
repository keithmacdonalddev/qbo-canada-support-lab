'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const { execute } = require('../../backend/test/helpers/case-engine-assessment-fixture');
const { createRunner } = require('../../backend/src/modules/reproduction-runner');
const { generateNote } = require('../../backend/src/modules/ai-notes');
const dist = path.resolve(__dirname, '../dist'), artifacts = path.resolve(__dirname, '../../artifacts/intent-ui');
test('desktop case workflow distinguishes source requirements, setup, symptom result, legacy trust and unavailable assessment', { timeout: 120000 }, async () => {
  const passed = await execute(), mismatch = await execute({ balance: 0 }), missing = await execute({ omitSymptom: true });
  assert.equal(passed.state.outcome, 'reproduced'); assert.equal(mismatch.state.outcome, 'not_reproduced'); assert.equal(missing.state.assessmentResult.setupComplete, true);
  let current = passed, unavailable = false, legacy = false, forcedNote = null;
  const posts = [], escaped = [], errors = [];
  const publicCase = async () => {
    let session = current.session;
    if (legacy) {
      session = JSON.parse(JSON.stringify(session));
      session.reproduction.summary = 'The executing assistant reported that its selected checks reproduced the issue.';
      session.reproduction.limitations = ['This saved result has no independent assessment.'];
      session.reproduction.conditions = session.reproduction.requestContract.payload.requirements.map(row => row.label);
      for (const key of ['caseContractVersion', 'assessment', 'assessmentResult', 'requestContract', 'requestSources']) delete session.reproduction[key];
    }
    const runner = createRunner({ config: { qbo: { environment: 'sandbox' } }, AISession: {}, User: {}, Connection: {}, CompanyMembership: {},
      AIPlan: { findOne: async () => { if (unavailable) throw Error('Synthetic optional evidence read unavailable'); return current.plan; } }, loadAssessmentAudit: current.loadAudit });
    return runner.publicState(session);
  };
  await fs.mkdir(artifacts, { recursive: true });
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://fixture').pathname, file = pathname.startsWith('/assets/') ? path.resolve(dist, '.' + pathname) : path.join(dist, 'index.html');
      if (!file.startsWith(dist + path.sep)) throw Error('Outside fixture');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end('Fixture asset unavailable'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  try {
    assert.equal((await publicCase()).reproduction.outcome, 'reproduced', 'The real public inspection must retain valid original proof.');
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { localStorage.setItem('token', 'isolated-case-assessment-ui'); window.fixtureCopies = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.fixtureCopies.push(text); } } }); });
    page = await context.newPage(); const origin = 'http://127.0.0.1:' + server.address().port;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { escaped.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const key = url.pathname.slice(5); let status = 200, body;
      if (request.method() !== 'GET') {
        posts.push({ key, body: request.postDataJSON() });
        if (key === 'ai/reproduce') {
          assert.equal(posts.at(-1).body.continueSaved, true); assert.equal(Object.hasOwn(posts.at(-1).body, 'message'), false);
          body = { success: true, data: { session: await publicCase() } };
        } else if (key === 'ai/generate-note') { assert.equal(posts.at(-1).body.format, 'internal'); body = { success: true, data: { note: forcedNote || await generateNote(await publicCase(), 'internal') } };
        } else { status = 403; body = { error: 'No writes in desktop inspection' }; }
      } else if (key === 'auth/me') body = { user: { id: 'owner', role: 'agent', displayName: 'Fixture owner' } };
      else if (key === 'qbo/status') body = { connected: true, status: 'active', connectionId: 'connection-1', realmId: 'realm', environment: 'sandbox', companyName: 'Fixture case company' };
      else if (key === 'ai/sessions/case-1') body = { success: true, data: { session: await publicCase() } };
      else if (key === 'ai/sessions/case-1/changes') body = { success: true, data: { changes: [], counts: { done: current.creates, working: 0, attention: 0, pending: 0 } } };
      else if (key === 'ai/sessions/case-1/screen') body = { success: true, data: { connected: false, available: false } };
      else { status = 503; body = { error: 'Outside isolated case inspection' }; }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const panel = page.getByRole('region', { name: 'Case status' });
    const shot = async name => { await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, name) }); };
    await page.goto(origin + '/cases/case-1');
    await panel.getByRole('heading', { name: 'Issue reproduced', exact: true }).waitFor();
    await panel.getByText(/Independently assessed against the original request/).waitFor();
    const requirements = panel.getByText('Original request requirements', { exact: true });
    await requirements.focus(); await page.keyboard.press('Enter');
    await panel.getByText(/Reported symptom: its remaining balance is 20/).first().waitFor();
    await panel.getByText(/Setup: verified in these observations/).waitFor();
    assert.equal(await panel.getByText(/Observed: 20 · Expected: 20 · Matched/).count(), 1);
    await shot('case-assessment-reproduced.png');
    await page.getByRole('button', { name: 'Write note', exact: true }).click();
    await page.getByText(/Result: Reported symptom observed/).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'case-assessment-note.png') });
    current = mismatch; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await panel.getByRole('heading', { name: 'Not reproduced in these tests', exact: true }).waitFor();
    await panel.getByText(/Observed: 0 · Expected: 20 · Did not match/).waitFor();
    await page.getByRole('button', { name: 'Write note', exact: true }).waitFor(); assert.equal(await page.getByText(/Result: Reported symptom observed/).count(), 0);
    await shot('case-assessment-not-reproduced.png');
    current = missing; await page.reload();
    await panel.getByRole('heading', { name: 'Not finished — result not verified', exact: true }).waitFor();
    await panel.getByText(/Setup: verified in these observations/).waitFor();
    const continuation = panel.getByRole('button', { name: 'Continue this case', exact: true });
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/ai/sessions/case-1') && response.request().method() === 'GET');
    await continuation.focus(); await page.keyboard.press('Enter'); await refreshed;
    const continuations = posts.filter(row => row.key === 'ai/reproduce');
    assert.equal(continuations.length, 1); assert.equal(posts.length, 2);
    assert.equal(continuations[0].body.realmId, 'realm'); assert.equal(continuations[0].body.environment, 'sandbox');
    await shot('case-assessment-setup-only.png');
    await page.getByRole('button', { name: 'Write note', exact: true }).click();
    await page.getByRole('button', { name: 'Copy', exact: true }).waitFor();
    forcedNote = await generateNote(await publicCase(), 'internal');
    // Recovery can change records while run, outcome, assessment hash and trust
    // remain unchanged. Copy must independently re-read the current decision.
    missing.state.decisionRevision = (missing.state.decisionRevision || 0) + 1;
    missing.state.ownedRecords.push({ entityType: 'Invoice', id: 'recovered-3' });
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.getByText('The saved case evidence changed. Write a new note before copying.', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixtureCopies), []);
    await page.screenshot({ path: path.join(artifacts, 'case-assessment-stale-note.png') });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Write note', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Write note', exact: true }).click();
    await page.getByText('The saved case evidence changed. Refresh before writing a note.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Copy', exact: true }).count(), 0);
    forcedNote = null;
    current = passed; unavailable = true; await page.reload();
    await panel.getByText(/The saved independent assessment cannot be verified/).waitFor();
    assert.equal(await panel.getByText(/Setup: verified in these observations/).count(), 0);
    await panel.getByRole('button', { name: 'Continue this case', exact: true }).waitFor();
    await shot('case-assessment-unavailable.png');
    unavailable = false; legacy = true; await page.reload();
    await panel.getByText(/Legacy result: the executing assistant chose and assessed these checks/).waitFor();
    assert.equal(await panel.getByText(/Independently assessed against the original request/).count(), 0);
    await shot('case-assessment-legacy.png');
    assert.deepEqual(errors, []); assert.deepEqual(escaped, []);
    assert.equal(passed.creates, 2); assert.equal(mismatch.creates, 2); assert.equal(missing.creates, 2);
  } catch (error) { if (page) { await page.screenshot({ path: path.join(artifacts, 'case-assessment-failure.png') }).catch(() => {}); await fs.writeFile(path.join(artifacts, 'case-assessment-failure.txt'), await page.locator('body').innerText()).catch(() => {}); } throw error;
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
