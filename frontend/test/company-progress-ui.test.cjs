'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const dist = path.resolve(__dirname, '../dist'), artifacts = path.resolve(__dirname, '../../artifacts/intent-ui');
test('Company desktop summary shows scoped evidence, links to existing workflow, and recovers from unavailable reads', { timeout: 90000 }, async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const server = http.createServer(async (req, res) => { try { const pathname = new URL(req.url, 'http://fixture').pathname, file = pathname.startsWith('/assets/') ? path.resolve(dist, '.' + pathname) : path.join(dist, 'index.html'); if (!file.startsWith(dist + path.sep)) throw Error('Outside fixture'); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await fs.readFile(file)); } catch { res.statusCode = 404; res.end('Fixture asset unavailable'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page; const held = [];
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('token', 'isolated-company-progress'));
    page = await context.newPage(); const origin = 'http://127.0.0.1:' + server.address().port, writes = [], escaped = [], errors = [];
    const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) };
    const observation = { scope, id: 'b'.repeat(24), evidenceHash: 'c'.repeat(64), accepted: false, activated: false, purpose: 'company-survey', period: { fromDate: '2026-09-01', throughDate: '2026-09-30' }, observedAt: '2026-10-01T12:00:00Z', evaluation: { checks: [{ key: 'balance', label: 'Trial balance', status: 'passed' }], reportCoverage: { complete: true, available: 7, required: 7 } } };
    let mode = 'loading', connected = true;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()); if (url.origin !== origin) { escaped.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let status = 200, body, key = url.pathname.slice(5);
      if (request.method() !== 'GET') { writes.push(key); return route.abort(); }
      if (key === 'auth/me') body = { user: { id: 'd'.repeat(24), role: 'agent', displayName: 'Fixture Owner' } };
      else if (key === 'qbo/status') body = { connected, status: connected ? 'active' : 'none', ...scope, companyName: 'Fixture Harbour Business' };
      else if (key === 'company/business-governance') {
        if (mode === 'loading') await new Promise(resolve => held.push(resolve));
        body = { data: { ...scope, owner: false, published: mode === 'empty' ? null : {}, calendar: { openingDate: '2026-09-01', verifiedThrough: null }, pendingOperations: [], currentOperation: null } };
      }
      else if (key === 'business-population') body = { data: { scope, owner: false, job: mode === 'empty' ? null : { scope, jobId: 'e'.repeat(24), status: 'populated', fromDate: '2026-09-01', throughDate: '2026-09-30', counts: { required: 100, saved: 100, contentChecked: 100, rejected: 0, unknown: 0, coverageGaps: 0, verificationErrors: 0 } } } };
      else if (key === 'company/business-baseline') { if (mode === 'error') { status = 503; body = { error: 'Fixture unavailable' }; } else body = { data: { scope, records: mode === 'empty' ? [] : [observation], next: null, canCapture: false } }; }
      else if (key === 'company/business-baseline/' + observation.id) body = { data: { ...observation, ...(mode === 'mismatch' ? { scope: { ...scope, realmId: '456' } } : {}) } };
      else if (key === 'company/health') body = { verified: false };
      else if (key === 'company/snapshot') body = { counts: {} };
      else if (key === 'explore/timeline') body = { entries: [] };
      else { status = 503; body = { error: 'Other workflow intentionally unavailable in this isolated inspection' }; }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin + '/company');
    const panel = page.getByRole('region', { name: 'Company progress and next action' });
    await panel.getByText('Reading saved records, calendar and accounting checks…').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'company-progress-loading.png') });
    mode = 'ready'; held.splice(0).forEach(resolve => resolve());
    const next = panel.getByRole('link', { name: 'Review business calendar', exact: true }); await next.waitFor();
    assert.equal(await panel.getByText('Sep 30, 2026', { exact: true }).count(), 2);
    await panel.getByText(/All saved accounting checks passed/).waitFor();
    await panel.getByText(/Calendar verified through: Not established/).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'company-progress-ready.png') });
    await next.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'business-maintenance');
    const refresh = panel.getByRole('button', { name: 'Refresh summary' });
    mode = 'error'; await refresh.click(); await panel.getByRole('alert').waitFor(); assert.equal(await panel.getByRole('link', { name: 'Review business calendar' }).count(), 0);
    await page.screenshot({ path: path.join(artifacts, 'company-progress-error.png') });
    mode = 'ready'; await refresh.click(); await next.waitFor();
    mode = 'mismatch'; await refresh.click(); await panel.getByRole('alert').waitFor(); assert.equal(await panel.getByText('Sep 30, 2026', { exact: true }).count(), 0);
    mode = 'empty'; await refresh.click(); await panel.getByRole('link', { name: 'Review company preparation' }).waitFor();
    await panel.getByText('No report observation has been saved.').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'company-progress-empty.png') });
    connected = false; await page.reload(); await panel.getByRole('link', { name: 'Open connection settings' }).waitFor(); assert.equal(await refresh.isEnabled(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(escaped, []);
  } catch (error) { if (page) await page.screenshot({ path: path.join(artifacts, 'company-progress-failure.png') }).catch(() => {}); throw error;
  } finally { held.splice(0).forEach(resolve => resolve()); await browser?.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});
