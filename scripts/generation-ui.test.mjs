// Isolated desktop check of the actual built React workflow. All API calls are fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'frontend/dist');
const artifacts = path.join(root, 'artifacts/generation-review');
await fs.mkdir(artifacts, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tdl-generation-ui-'));
let browser; let chrome; let server;
const pageErrors = []; const unexpected = []; const posts = [];
const id = '000000000000000000000011';
const partial = { _id: id, status: 'partial', statusLabel: 'Partially successful', success: false, canResume: true,
  canCreateAdditional: false, config: { monthsBack: 3, txnsPerMonth: 10 },
  counts: { created: 1, failed: 1, pending: 1, uncertain: 0, planned: 3 }, txnsSummary: { invoices: 1 },
  generationErrors: [{ type: 'payment', detail: 'Fixture payment rejected' }],
  createdTransactions: [{ entity: 'Invoice', qboId: 'fixture-invoice', amount: 100, txnDate: '2026-09-01', timestamp: '2026-10-02T12:00:00Z' }],
  lastError: 'Payment rejected. The saved invoice will be skipped when you resume.',
  recoveryMessage: 'Resume uses the saved plan and skips records already created.' };
let current = null; let failStatus = false; let environment = 'sandbox';
try {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = path.resolve(dist, '.' + pathname);
      if (!file.startsWith(dist + path.sep) && file !== dist) { res.writeHead(403).end(); return; }
      if (!path.extname(file)) file = path.join(dist, 'index.html');
      const content = await fs.readFile(file);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const executable = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  let chromePath;
  for (const candidate of executable) if (await fs.stat(candidate).then(() => true).catch(() => false)) { chromePath = candidate; break; }
  assert.ok(chromePath, 'A local browser is required');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser did not start')), 20000);
    let output = '';
    chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.once('error', error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('token', 'fixture-only'));
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { unexpected.push(url.origin); await route.abort(); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    let body; let status = 200;
    if (url.pathname === '/api/auth/me') body = { user: { email: 'fixture@example.test', role: 'supervisor' } };
    else if (url.pathname === '/api/qbo/status') body = { companyName: 'Fixture Company', connected: true, status: 'active', environment, realmId: 'fixture-realm' };
    else if (url.pathname === '/api/seed/history') body = { seedRuns: [] };
    else if (url.pathname === '/api/generate/history') body = { genRuns: current ? [current] : [] };
    else if (url.pathname === '/api/generate/status') { body = failStatus ? { error: 'Fixture status unavailable' } : { genRun: current }; status = failStatus ? 503 : 200; }
    else if (url.pathname.startsWith('/api/generate/log/')) body = { ...current, transactions: current.createdTransactions || [], errors: current.generationErrors || [] };
    else if (url.pathname === '/api/generate/start') {
      posts.push(route.request().postDataJSON());
      current = { ...partial, status: 'completed', statusLabel: 'Successful', success: true, canResume: false, canCreateAdditional: true,
        counts: { created: 3, failed: 0, pending: 0, uncertain: 0, planned: 3 }, lastError: null, recoveryMessage: null, generationErrors: [] };
      body = { genRun: current };
    } else { unexpected.push(url.pathname); body = { error: 'Unexpected fixture request' }; status = 500; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(origin + '/lab');
  await page.getByRole('button', { name: 'Generate History', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Generate History', exact: true }).isEnabled(), true);
  current = structuredClone(partial); environment = 'production';
  await page.reload();
  const resume = page.getByRole('button', { name: 'Resume Saved Run', exact: true });
  await resume.waitFor(); await resume.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'partial.png'), fullPage: true });
  await resume.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Resume Saved Run', exact: true }).isDisabled(), true);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('textbox').fill('PRODUCTION');
  await dialog.getByRole('button', { name: 'Resume Saved Run', exact: true }).click();
  await page.getByRole('button', { name: 'History Generated' }).waitFor();
  assert.equal(posts.length, 1); assert.equal(posts[0].resumeRunId, id); assert.equal(posts[0].confirmProduction, true);
  assert.match(await page.locator('main').innerText(), /Successful: 3 created/);
  await page.screenshot({ path: path.join(artifacts, 'successful.png'), fullPage: true });
  await page.getByRole('button', { name: 'Add Another Batch', exact: true }).click();
  await dialog.waitFor(); assert.match(await dialog.innerText(), /Adds MORE transactions/);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(posts.length, 1);
  current = { ...partial, status: 'in_progress', statusLabel: 'Running', canResume: false, progress: { detail: '1 of 3 records created' } };
  await page.reload(); await page.getByRole('button', { name: 'Generating...', exact: true }).waitFor();
  current = { ...partial, status: 'interrupted', statusLabel: 'Needs attention', canResume: false,
    counts: { created: 1, failed: 0, pending: 1, uncertain: 1, planned: 3 },
    lastError: 'Reply lost. Inspect QuickBooks before creating more records.', recoveryMessage: 'QuickBooks may have accepted this transaction.',
    inspection: [{ entity: 'Payment', txnDate: '2026-09-02', amount: 100, customerOrVendor: 'Fixture Customer', linkedTo: 'Invoice #fixture-invoice' }] };
  await page.getByRole('button', { name: 'Inspection Needed', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Inspection Needed', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Add Another Batch', exact: true }).count(), 0);
  assert.match(await page.locator('main').innerText(), /Check in QuickBooks: Payment/);
  await page.screenshot({ path: path.join(artifacts, 'uncertain.png'), fullPage: true });
  failStatus = true; await page.reload();
  await page.getByText('Fixture status unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Generate History', exact: true }).isDisabled(), true);
  assert.deepEqual(pageErrors, []); assert.deepEqual(unexpected, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS: actual React desktop workflow; empty, saved partial, production-confirmed resume, success, additional-batch warning, running restore, uncertain stop, status error; no external API calls.');
} finally {
  if (browser) {
    try { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close'); } catch { /* already closed */ }
    await browser.close().catch(() => {});
  }
  if (chrome && chrome.exitCode === null) {
    await Promise.race([once(chrome, 'close'), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (chrome.exitCode === null) await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve()));
    assert.notEqual(chrome.exitCode, null, 'Owned browser process must exit');
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('tdl-generation-ui-')) throw new Error('Unexpected cleanup path');
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  console.log('Cleanup: isolated loopback server closed; owned browser exited; temporary browser profile cleanup attempted.');
}
