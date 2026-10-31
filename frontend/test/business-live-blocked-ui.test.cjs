'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), { MemoryRouter } = require('react-router-dom');
const { chromium } = require('playwright-core');
const { buildLiveFeed } = require('../../backend/src/modules/business-agent-live');
test('desktop Live panel shows a blocked claimed Invoice without a spinner and names genuine waits', { timeout: 30000 }, async () => {
  const { build } = await import('rolldown');
  const root = path.resolve(__dirname, '../..'), component = path.join(root, 'frontend/src/components/BusinessLive.jsx');
  const bundle = await build({ input: component, platform: 'node', external: [/^react/, /^lucide/], transform: { jsx: { runtime: 'automatic' } }, output: { format: 'cjs' }, write: false, plugins: [{ name: 'isolated-component', load(id) { if (id.endsWith('.css')) return { code: '', moduleType: 'js' }; if (process.env.QBO_R3_CANDIDATE && path.resolve(id) === component) return fs.readFile(path.join(process.env.QBO_R3_CANDIDATE, 'frontend/src/components/BusinessLive.jsx'), 'utf8'); } }] });
  const compiled = new Module(component, module); compiled.filename = component; compiled.paths = Module._nodeModulePaths(path.dirname(component)); compiled._compile(bundle.output[0].code, component); const BusinessLive = compiled.exports.default || compiled.exports;
  const now = Date.parse('2026-10-31T21:14:06Z'), blockedAt = '2026-10-31T21:04:06.000Z', id = 'a'.repeat(24), reason = 'The selected Item differs from its approved definition or version.';
  const run = { _id: id, status: 'blocked', createdAt: '2026-10-31T20:00:00Z', updatedAt: blockedAt, recordCount: 36, nextOrdinal: 21, executionRequest: { completedAt: blockedAt, result: { code: 'BUSINESS_REFERENCE_UNVERIFIED', error: reason } } };
  const step = { _id: 'invoice', operationId: id, entity: 'Invoice', state: 'claimed', createdAt: '2026-10-31T20:00:00Z', updatedAt: '2026-10-31T20:00:00Z' };
  const props = { now, rightNow: { state: 'idle' }, transcript: { entries: [] }, feed: buildLiveFeed({ now, settings: { monitoring: true }, runs: [run], steps: [step] }) };
  const render = () => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(BusinessLive, props)));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const cssDir = process.env.QBO_R3_DIST || path.join(root, 'frontend/dist');
    const assets = await fs.readdir(path.join(cssDir, 'assets')); const css = (await Promise.all(assets.filter(name => name.endsWith('.css')).map(name => fs.readFile(path.join(cssDir, 'assets', name), 'utf8')))).join('\n');
    await page.setContent('<style>' + css + '</style>' + render());
    const row = page.locator('.bwl-item--record');
    await row.getByText('Blocked: ' + reason, { exact: false }).waitFor(); assert.match(await row.innerText(), /blocked 10 min ago/);
    assert.equal(await row.locator('.animate-spin').count(), 0); assert.equal(await page.locator('.animate-spin').count(), 0); assert.equal(await row.getByText(/Sending to QuickBooks/).count(), 0);
    await row.getByText('Details', { exact: false }).click(); await row.getByText('Time blocked', { exact: true }).waitFor();
    assert.ok(await row.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: path.join(os.tmpdir(), 'qbo-r3-live-blocked-desktop.png') });
    props.feed = buildLiveFeed({ now, settings: { monitoring: true }, runs: [{ ...run, status: 'running' }], steps: [step] });
    await page.setContent('<style>' + css + '</style>' + render()); await page.locator('.bwl-item--record').getByText(/Waiting for reference and safety checks before sending/).waitFor(); assert.equal(await page.locator('.bwl-item--record .animate-spin').count(), 0);
    // A stale client status must not reintroduce a spinner once blocked metadata is present.
    props.feed.items.find(item => item.id === 'step:invoice').status = 'running'; props.feed.items.find(item => item.id === 'step:invoice').blockedAt = blockedAt; props.feed.items.find(item => item.id === 'step:invoice').operationStatus = 'blocked';
    await page.setContent(render()); assert.equal(await page.locator('.bwl-item--record .animate-spin').count(), 0);
  } finally { await browser?.close(); }
});
