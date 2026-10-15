'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const dist = path.resolve(__dirname, '../dist'), artifacts = path.resolve(__dirname, '../../artifacts/intent-ui');
test('rendered owner setup separates review, storage, coordination and acknowledgement recovery', { timeout: 60000 }, async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://fixture').pathname;
      const file = pathname.startsWith('/assets/') ? path.resolve(dist, '.' + pathname) : path.join(dist, 'index.html');
      if (!file.startsWith(dist + path.sep)) throw new Error('outside fixture');
      const body = await fs.readFile(file); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(body);
    } catch { res.statusCode = 404; res.end('Fixture asset unavailable'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('token', 'isolated-fixture-token'));
    const page = await context.newPage(), origin = 'http://127.0.0.1:' + server.address().port;
    const writes = [], escaped = [], pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let view = { companyName: 'Fixture Company', environment: 'sandbox', realmId: '123', owner: true, storage: { ready: false }, coordination: { state: 'unprepared' } };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { escaped.push(request.url()); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let status = 200, body;
      const key = url.pathname.replace('/api/', '');
      if (key === 'auth/me') body = { user: { id: 'b'.repeat(24), displayName: 'Fixture Owner', role: 'agent' } };
      else if (key === 'qbo/status') body = { connected: true, status: 'active', environment: 'sandbox', realmId: '123', companyName: 'Fixture Company' };
      else if (key === 'company/business-setup') body = { data: view };
      else if (key.startsWith('company/business-setup/')) {
        assert.equal(request.method(), 'POST'); writes.push(key);
        if (key.endsWith('/preview')) body = { data: { planHash: 'a'.repeat(64), permissionChange: { to: 'lab-owner' } } };
        else if (key.endsWith('/apply')) { view.storage.ready = true; body = { data: { status: 'complete' } }; }
        else if (key.endsWith('/prepare')) { view.coordination.state = 'preparing'; body = { data: { state: 'preparing', preparationEvidenceHash: 'c'.repeat(64) } }; }
        else if (key.endsWith('/activate')) { view.coordination.state = 'active'; status = 503; body = { error: 'Fixture lost activation acknowledgement' }; }
        else throw new Error('Unexpected setup write');
      } else { status = 503; body = { error: 'Other panel is outside this isolated setup fixture.' }; }
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin + '/company');
    const panel = page.getByRole('region', { name: 'Business access and preparation' });
    await panel.getByRole('button', { name: 'Review preparation', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Review preparation', exact: true }).focus(); await page.keyboard.press('Enter');
    await panel.getByRole('button', { name: 'Prepare storage and owner access', exact: true }).waitFor();
    assert.equal(writes.length, 1); assert.match(await panel.innerText(), /creates no accounting records/);
    await panel.screenshot({ path: path.join(artifacts, 'setup-preview.png') });
    await panel.getByRole('button', { name: 'Prepare storage and owner access', exact: true }).click();
    await panel.getByRole('button', { name: 'Prepare company write coordination', exact: true }).waitFor(); assert.equal(writes.length, 2);
    await panel.getByRole('button', { name: 'Prepare company write coordination', exact: true }).click();
    await panel.getByRole('button', { name: 'Enable coordinated company writes', exact: true }).waitFor();
    await panel.screenshot({ path: path.join(artifacts, 'setup-preparing.png') });
    await panel.getByRole('button', { name: 'Enable coordinated company writes', exact: true }).click();
    await panel.getByText('Fixture lost activation acknowledgement', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Business access and preparation"]')?.textContent.includes('Company write coordination is ready.'));
    await panel.screenshot({ path: path.join(artifacts, 'setup-recovered.png') });
    assert.equal(writes.length, 4); assert.equal(await panel.getByRole('button', { name: 'Enable coordinated company writes', exact: true }).count(), 0);
    view = { ...view, owner: false, storage: { ready: false }, coordination: { state: 'unprepared' } }; await page.reload();
    await panel.getByText('The connected company owner must complete this step.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Review preparation', exact: true }).count(), 0);
    assert.deepEqual(escaped, []); assert.deepEqual(pageErrors, []);
    await context.close();
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
