'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const { fixture, scope, ownerId } = require('../../backend/test/helpers/business-governance-fixture');
const { draftView, proposalView } = require('../../backend/src/modules/blueprint-draft');
const { previewBusinessActivity } = require('../../backend/src/modules/business-activity-preview');
const config = require('../../backend/src/config'), dist = path.resolve(__dirname, '../dist'), artifacts = path.resolve(__dirname, '../../artifacts/intent-ui');
test('desktop credit preview explains adjustment, zero cash and exact remainder, while Production adoption stays visibly pending', { timeout: 120000 }, async () => {
  const previous = config.qbo.environment; config.qbo.environment = 'sandbox';
  const h = fixture({ activityTemplateVersion: 3, originalSdkTransport: true, copyOnWriteTransactions: true });
  const draft = draftView(h.data.Versions[0], scope.connectionId), proposal = proposalView();
  await fs.mkdir(artifacts, { recursive: true });
  const server = http.createServer(async (req, res) => { try { const pathname = new URL(req.url, 'http://fixture').pathname, file = pathname.startsWith('/assets/') ? path.resolve(dist, '.' + pathname) : path.join(dist, 'index.html'); if (!file.startsWith(dist + path.sep)) throw Error('Outside fixture'); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await fs.readFile(file)); } catch { res.statusCode = 404; res.end('Fixture asset unavailable'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let browser, page, context;
  const escaped = [], errors = [], unexpected = [], previewRequests = [];
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const origin = 'http://127.0.0.1:' + server.address().port;
    for (const environment of ['sandbox', 'production']) {
      const shownScope = { ...scope, environment }, view = { ...shownScope, draft, proposal, mappingDefinitions: {}, masterDefinitions: {}, activationNeeds: [], storage: { ready: true }, permissionToSave: false, canSave: false };
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(() => localStorage.setItem('token', 'isolated-care-credit-desktop'));
      page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { escaped.push(url.origin); return route.abort(); }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const key = url.pathname.slice(5); let status = 200, body;
        if (request.method() === 'POST' && key === 'company/business-plan/activity-preview') {
          const input = request.postDataJSON(); previewRequests.push({ environment, input });
          body = { data: previewBusinessActivity(view, input, '2026-12-01') };
        } else if (request.method() !== 'GET') { unexpected.push({ key, method: request.method() }); status = 403; body = { error: 'Outside read-only credit preview' }; }
        else if (key === 'auth/me') body = { user: { id: ownerId, role: 'agent', displayName: 'Fixture owner' } };
        else if (key === 'qbo/status') body = { connected: true, status: 'active', ...shownScope, companyName: 'Fixture Harbour business' };
        else if (key === 'company/business-plan') body = { data: view };
        else if (key === 'company/business-governance') body = { data: { ...shownScope, owner: true, companyName: 'Fixture Harbour business', published: null, calendar: null, pendingOperations: [] } };
        else if (key === 'company/business-baseline') body = { data: { ...shownScope, scope: shownScope, records: [], next: null, canCapture: false, blueprint: { id: draft.id, contentHash: draft.contentHash, version: draft.version, openingDate: draft.business.openingDate } } };
        else if (key === 'business-operations') body = { data: { scope: shownScope, operations: [], next: null } };
        else { status = 503; body = { error: 'Outside isolated credit preview' }; }
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(origin + '/company');
      await page.getByRole('combobox', { name: 'Business schedule', exact: true }).waitFor();
      assert.equal(await page.getByRole('combobox', { name: 'Business schedule', exact: true }).inputValue(), '3');
      const preview = page.getByRole('region', { name: 'Business activity preview', exact: true });
      await preview.getByLabel('Activity from date', { exact: true }).fill('2026-10-16');
      await preview.getByLabel('Activity through date', { exact: true }).fill('2026-10-20');
      await preview.getByRole('button', { name: 'Preview activity', exact: true }).click();
      await preview.getByText('Scheduled records by date', { exact: true }).click();
      const credit = preview.getByRole('row').filter({ hasText: 'Credit a ten-percent care-service adjustment' });
      const application = preview.getByRole('row').filter({ hasText: 'Apply the saved care-service credit without collecting cash' });
      const cash = preview.getByRole('row').filter({ hasText: 'care-subscription-002' }).filter({ hasText: 'Collect the care-plan invoice' });
      await credit.getByText('Credit 10% of the original care service before tax. Keep its original customer, service and tax treatment.', { exact: true }).waitFor();
      await application.getByText('Apply the exact saved credit to its invoice. No money is collected or deposited.', { exact: true }).waitFor();
      await cash.getByText('Collect the original saved invoice total less the exact saved credit, including their actual tax.', { exact: true }).waitFor();
      assert.equal(previewRequests.at(-1).input.fromDate, '2026-10-16'); assert.equal(previewRequests.at(-1).input.throughDate, '2026-10-20');
      if (environment === 'sandbox') {
        await credit.evaluate(el => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: 'instant' }));
        await page.screenshot({ path: path.join(artifacts, 'business-care-credit-preview-viewport.png') });
        await application.evaluate(el => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: 'instant' }));
        await page.screenshot({ path: path.join(artifacts, 'business-care-credit-application-viewport.png') });
      } else {
        const publication = page.getByRole('region', { name: 'Business publication and calendar', exact: true });
        await publication.getByText('The customer-credit schedule can be saved and previewed. A direct Canadian company check is required before Production publication. Keep the continuing schedule for current operations.', { exact: true }).waitFor();
        assert.equal(await publication.getByRole('button', { name: 'Review publication', exact: true }).isDisabled(), true);
        await publication.evaluate(el => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 100, behavior: 'instant' }));
        await page.screenshot({ path: path.join(artifacts, 'business-care-credit-production-pending-viewport.png') });
      }
      assert.equal(await page.getByText(/company (connection )?changed/i).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await context.close(); context = null; page = null;
    }
    assert.equal(h.posts, 0); assert.equal(previewRequests.length, 2); assert.deepEqual(escaped, []); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } catch (error) { if (page) { await page.screenshot({ path: path.join(artifacts, 'business-care-credit-ui-failure.png') }); await fs.writeFile(path.join(artifacts, 'business-care-credit-ui-failure.txt'), await page.locator('body').innerText()); } throw error; }
  finally { await context?.close(); await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); config.qbo.environment = previous; }
});
