'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const { fixture, accounts } = require('../../backend/test/helpers/business-report-fixtures');
const period = { fromDate: '2026-09-01', throughDate: '2026-09-30' };
const { evaluateBooks } = require('../../backend/src/modules/book-evidence');
const dist = path.resolve(__dirname, '../dist'), artifacts = path.resolve(__dirname, '../../artifacts/intent-ui');
test('focused desktop book checks make no QBO reads until explicit period check', { timeout: 90000 }, async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const server = http.createServer(async (req, res) => { try { const pathname = new URL(req.url, 'http://fixture').pathname, file = pathname.startsWith('/assets/') ? path.resolve(dist, '.' + pathname) : path.join(dist, 'index.html'); if (!file.startsWith(dist + path.sep)) throw Error('Outside fixture'); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await fs.readFile(file)); } catch { res.statusCode = 404; res.end('Fixture asset unavailable'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page, release;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('token', 'isolated-focused-reports'));
    page = await context.newPage(); const origin = 'http://127.0.0.1:' + server.address().port, requests = [], escaped = [], errors = [];
    const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) }, reports = fixture({ critical: true });
    for (const report of Object.values(reports)) { report.Header.StartPeriod = period.fromDate; report.Header.EndPeriod = period.throughDate; }
    const evidence = evaluateBooks(reports, period, {}, accounts, { includeCritical: true, allowExplicitZero: true });
    let mode = 'ready', connected = true;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()); if (url.origin !== origin) { escaped.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue(); requests.push({ method: request.method(), path: url.pathname, query: Object.fromEntries(url.searchParams) });
      let status = 200, body;
      if (request.method() !== 'GET') { status = 403; body = { error: 'No writes in focused report inspection' }; }
      else if (url.pathname === '/api/auth/me') body = { user: { id: 'b'.repeat(24), role: 'agent', displayName: 'Fixture owner' } };
      else if (url.pathname === '/api/qbo/status') body = { connected, status: connected ? 'active' : 'none', ...scope, companyName: 'Fixture Harbour Business' };
      else if (url.pathname === '/api/company/book-evidence') { if (mode === 'hold') await new Promise(resolve => { release = resolve; }); if (mode === 'error') { status = 429; body = { error: 'Fixture read limit reached' }; } else body = { data: { ...scope, ...evidence, readAttempts: 7, checkedAt: new Date().toISOString() } }; }
      else { status = 503; body = { error: 'Unexpected API request in focused report workflow' }; }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin + '/company/reports');
    await page.getByRole('heading', { name: 'Book checks', exact: true, level: 1 }).waitFor();
    const panel = page.getByRole('region', { name: 'Book checks' }), check = panel.getByRole('button', { name: 'Check reports', exact: true });
    await page.getByText('Fixture Harbour Business', { exact: true }).first().waitFor(); await check.waitFor();
    assert.ok(requests.every(row => ['/api/auth/me', '/api/qbo/status'].includes(row.path)), JSON.stringify(requests));
    assert.equal(requests.filter(row => row.path === '/api/company/book-evidence').length, 0);
    await page.screenshot({ path: path.join(artifacts, 'book-checks-focused-ready.png') });
    // Native autofill/extension changes may not dispatch React change events.
    // The actual visible date values must still determine the request.
    await panel.getByLabel('Book checks from date').evaluate((input, value) => { input.value = value; }, period.fromDate);
    await panel.getByLabel('Book checks through date').evaluate((input, value) => { input.value = value; }, period.throughDate);
    await check.focus(); await page.keyboard.press('Enter'); await panel.getByText(/7 of 7 critical reports confirm/).waitFor();
    assert.deepEqual(requests.filter(row => row.path === '/api/company/book-evidence'), [{ method: 'GET', path: '/api/company/book-evidence', query: { fromDate: period.fromDate, throughDate: period.throughDate } }]);
    await panel.locator('summary').click(); await panel.getByText('7 QuickBooks read attempts for this check.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'book-checks-focused-results.png') });
    await panel.getByLabel('Book checks from date').fill('2026-09-30'); await panel.getByLabel('Book checks through date').fill('2026-09-01');
    await check.click(); await panel.getByRole('alert').filter({ hasText: 'Choose a valid elapsed reporting period.' }).waitFor();
    assert.equal(requests.filter(row => row.path === '/api/company/book-evidence').length, 1);
    await panel.getByLabel('Book checks from date').fill(period.fromDate); await panel.getByLabel('Book checks through date').fill(period.throughDate);
    mode = 'hold'; await check.click(); await panel.getByRole('status').filter({ hasText: '2026-09-01 through 2026-09-30' }).waitFor();
    assert.equal(await panel.getByLabel('Book checks from date').inputValue(), period.fromDate); assert.equal(await panel.getByLabel('Book checks through date').inputValue(), period.throughDate);
    const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/company/book-evidence');
    await panel.getByRole('button', { name: 'Cancel check', exact: true }).click(); await aborted;
    await panel.getByRole('alert').filter({ hasText: 'Report check stopped.' }).waitFor();
    release(); release = null; assert.equal(await panel.getByText(/7 of 7 critical reports confirm/).count(), 0);
    mode = 'error'; await check.click(); await panel.getByRole('alert').filter({ hasText: 'Fixture read limit reached' }).waitFor(); assert.equal(await panel.getByText(/7 of 7 critical reports confirm/).count(), 0);
    await page.screenshot({ path: path.join(artifacts, 'book-checks-focused-error.png') });
    connected = false; await page.reload(); assert.equal(await check.isEnabled(), false); await page.getByText('No QuickBooks company is connected yet.', { exact: true }).waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(escaped, []); assert.ok(requests.every(row => row.method === 'GET')); assert.ok(requests.every(row => ['/api/auth/me', '/api/qbo/status', '/api/company/book-evidence'].includes(row.path)));
    assert.equal(requests.filter(row => row.path === '/api/company/book-evidence').length, 3);
  } catch (error) { if (page) await page.screenshot({ path: path.join(artifacts, 'book-checks-focused-failure.png') }).catch(() => {}); throw error;
  } finally { release?.(); await browser?.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});
