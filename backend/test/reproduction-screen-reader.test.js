'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright-core');
const base = path.resolve(__dirname, '../../extensions/qbo-screen-reader');

const request = { id: '608', docNumber: 'REPRO-T7', lines: [{ item: 'Hours', quantity: 6 }] };
const html = (billed = '5', extra = '') => '<label for="number">Purchase order no.</label><input id="number" value="REPRO-T7"><table><tr><th>Product/Service</th><th>Description</th><th>Qty</th><th>Billed</th></tr><tr><td>Hours</td><td>Test hours</td><td><input value="6"></td><td>' + billed + '</td></tr></table>' + extra;

test('fixed DOM reader accepts labelled values and rejects hidden, ambiguous or incomplete evidence', async (t) => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Route every request to a synthetic fixture. No live QBO or app calls.
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html() }));
  await page.goto('https://qbo.intuit.com/app/purchaseorder?txnId=608');
  const reader = await fs.readFile(path.join(base, 'reader.js'), 'utf8');
  const read = () => page.evaluate((r) => globalThis.TDLScreenReader.read(r), request);
  await page.addScriptTag({ content: reader });
  assert.equal((await read()).rows[0].value, 5);
  await page.setContent(html('<input type="hidden" value="99">5'));
  assert.equal((await read()).rows[0].value, 5, 'hidden control cannot replace displayed text');
  for (const change of [
    'document.querySelectorAll("th")[3].style.display="none"',
    'document.querySelectorAll("td")[3].style.display="none"',
    'document.querySelectorAll("td")[3].style.opacity="0"',
    'document.querySelector("#number").value="OTHER"',
    'document.body.insertAdjacentHTML("beforeend",document.querySelector("table").outerHTML)',
    'document.querySelectorAll("td")[3].textContent=""',
    'document.querySelector("table").setAttribute("aria-busy","true")',
  ]) {
    await page.setContent(html()); await page.evaluate(change);
    await assert.rejects(read());
  }
  await page.setContent(html('3.5').replace('<th>Billed</th>', '<th>RECEIVED</th>'));
  await assert.rejects(read(), /requested quantity/);
  const received = await page.evaluate((r) => TDLScreenReader.read({ ...r, field: 'receivedQuantity' }), request);
  assert.equal(received.field, 'receivedQuantity'); assert.equal(received.rows[0].label, 'RECEIVED');
  assert.equal(received.rows[0].value, 3.5);
  // setContent replaces the document and its event listeners; use a fresh
  // navigation and injection to model how the companion attaches in Chrome.
  await page.goto('https://qbo.intuit.com/app/purchaseorder?txnId=608');
  await page.addScriptTag({ content: reader });
  await page.locator('#number').fill('Changed by user');
  await assert.rejects(read(), /user edits/);
  await page.goto('https://qbo.intuit.com/app/purchaseorder?txnId=608');
  await page.addScriptTag({ content: reader });
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<button>Remove line</button>'));
  await page.getByRole('button', { name: 'Remove line' }).click();
  await assert.rejects(read(), /user edits/, 'button-only interaction protects the tab');
});

test('company identity must appear inside a recognised visible dialog', async (t) => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div role="dialog" aria-label="Bill note">Company ID: 123456</div>');
  await page.addScriptTag({ content: await fs.readFile(path.join(base, 'reader.js'), 'utf8') });
  assert.equal(await page.evaluate(() => TDLScreenReader.identity()), null);
  await page.setContent('<div role="dialog" aria-label="Company information">Company ID: 123456</div>');
  assert.equal(await page.evaluate(() => TDLScreenReader.identity()), '123456');
  await page.setContent('<div role="dialog" aria-label="Company ID and keyboard shortcuts">Your Company ID is <strong>1234 5678 9012</strong></div>');
  assert.equal(await page.evaluate(() => TDLScreenReader.identity()), '123456789012');
  await page.locator('[role=dialog]').evaluate((el) => { el.style.display = 'none'; });
  assert.equal(await page.evaluate(() => TDLScreenReader.identity()), null);
});


// Browser lifecycle contract with fake Chrome APIs. No live app or QBO calls.
async function companion(options = {}) {
  const listeners = {};
  const store = options.store || {};
  const tabs = options.tabs || new Map();
  if (!tabs.has(10)) tabs.set(10, { id: 10, windowId: 1, url: 'http://localhost:5173/cases/test', status: 'complete', active: true });
  const actions = { created: [], navigated: [], injected: [], reads: [], focused: [] };
  let nextId = 20;
  let sourceValue = 5;
  let elapsed = 0;
  let identityOpen = !options.identityDelayMs;
  let readAttempts = 0;
  const startedAt = Date.now();
  const authorized = { ...request, nonce: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', entityType: 'PurchaseOrder',
    field: 'receivedQuantity', realmId: '123456', environment: 'production', expiresAt: Date.now() + 45000 };
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const context = { URL, AbortSignal, Date: class extends Date { static now() { return startedAt + elapsed; } },
    setTimeout: (fn, ms) => { elapsed += ms; return setTimeout(fn, 0); }, clearTimeout,
    fetch: async () => ({ ok: options.authorized !== false, json: async () => ({ request: authorized }) }),
    chrome: {
      runtime: { id: 'test-extension', onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
      permissions: { contains: async () => options.permission !== false, onAdded: event('permissionAdded'), onRemoved: event('permissionRemoved') },
      storage: { session: { get: async () => ({ ...store }), set: async (value) => Object.assign(store, value), remove: async (key) => { delete store[key]; } } },
      scripting: { executeScript: async (opts) => {
        actions.injected.push({ id: opts.target.tabId, file: opts.files?.[0] });
        const tab = tabs.get(opts.target.tabId);
        if (opts.files) {
          if (opts.files[0] === 'reader.js') {
            if (options.injectFailure) throw new Error('Injection failed');
            tab.guarded = true;
          }
          return [];
        }
        const name = opts.args[0];
        if (name === 'dirty' && options.switchDuringRestore && actions.reads.length >= 2) listeners.activated({ tabId: 99, windowId: 1 });
        if (name === 'openIdentity' && elapsed >= (options.identityDelayMs || 0)) identityOpen = true;
        if (name === 'closeIdentity' && options.identityDelayMs) identityOpen = false;
        if (name === 'read') {
          if (options.requireVisible && !tab.active) return [{ result: { ok: false, error: 'The visible purchase order number could not be verified.' } }];
          if (options.userSwitch) tab.active = false;
          if (readAttempts++ < (options.readDelayAttempts || 0)) return [{ result: { ok: false, error: 'The visible purchase order number could not be verified.' } }];
          actions.reads.push(tab.displayValue);
          if (options.readError) return [{ result: { ok: false, error: 'Requested column is absent.' } }];
        }
        const value = name === 'dirty' ? !tab.guarded || !!tab.dirty : name === 'identity' ? (identityOpen ? (options.realmId || '123456') : null)
          : name === 'read' ? { id: '608', rows: [{ value: tab.displayValue }] } : null;
        return [{ result: { ok: true, value } }];
      } },
      action: { onClicked: event('action'), setBadgeText: async () => {}, setTitle: async () => {} },
      tabs: { onRemoved: event('removed'), onActivated: event('activated'),
        query: async (filter) => filter.active ? [...tabs.values()].filter((tab) => tab.active && tab.windowId === filter.windowId) : [tabs.get(10)],
        get: async (id) => {
          const tab = tabs.get(id); if (!tab) throw new Error('No tab');
          if (tab.pendingUrl) {
            const pending = { ...tab };
            tab.url = tab.pendingUrl; delete tab.pendingUrl; tab.status = 'complete';
            return pending;
          }
          return { ...tab };
        },
        create: async (spec) => {
          assert.equal(spec.active, true); assert.equal(spec.windowId, 1);
          for (const existing of tabs.values()) existing.active = false;
          const tab = { id: nextId++, windowId: 1, active: true, url: 'about:blank', pendingUrl: spec.url, status: 'loading', displayValue: sourceValue };
          tabs.set(tab.id, tab); actions.created.push(spec); return { ...tab };
        },
        update: async (id, spec) => {
          const tab = tabs.get(id);
          if (spec.active) {
            for (const existing of tabs.values()) existing.active = false;
            tab.active = true; actions.focused.push(id); listeners.activated({ tabId: id, windowId: tab.windowId }); return { ...tab };
          }
          assert.equal(tab.dirty, undefined, 'never navigate a manually edited tab');
          tab.pendingUrl = spec.url; tab.status = 'loading'; tab.displayValue = sourceValue; tab.guarded = false;
          actions.navigated.push({ id, url: spec.url }); return { ...tab };
        } },
    },
  };
  vm.runInNewContext(await fs.readFile(path.join(base, 'background.js'), 'utf8'), context);
  const sender = { id: 'test-extension', frameId: 0, tab: { id: 10, windowId: 1 }, url: 'http://localhost:5173/cases/test' };
  return { actions, store, tabs, listeners, authorized,
    setValue: (v) => { sourceValue = v; },
    status: () => new Promise((resolve) => listeners.message({ type: 'tdl-screen-status' }, sender, resolve)),
    capture: () => { authorized.nonce = require('node:crypto').randomUUID();
      return new Promise((resolve) => listeners.message({ type: 'tdl-screen-capture', request: { ...authorized } }, sender, resolve)); },
  };
}

test('automatic permission readiness creates no tabs; revoked permission and forged requests cannot navigate', async () => {
  const ready = await companion();
  assert.equal((await ready.status()).ready, true);
  assert.equal(ready.actions.created.length, 0);
  for (const options of [{ permission: false }, { authorized: false }]) {
    const c = await companion(options);
    assert.ok((await c.capture()).error);
    assert.equal(c.actions.created.length, 0); assert.equal(c.actions.navigated.length, 0);
  }
});

test('authorized checks create their own tab without a toolbar click and refresh repeated PO observations', async () => {
  const c = await companion();
  const first = await c.capture();
  assert.equal(first.error, undefined); assert.equal(first.evidence.rows[0].value, 5);
  assert.equal(c.actions.created.length, 1); assert.equal(c.actions.navigated.length, 1);
  c.setValue(3.5); // A bill edit changes QBO data, while the open tab still displays 5.
  assert.equal(c.tabs.get(c.store.readerTab.id).displayValue, 5);
  const second = await c.capture();
  assert.equal(second.error, undefined); assert.equal(second.evidence.rows[0].value, 3.5);
  assert.equal(c.actions.created.length, 1); assert.equal(c.actions.navigated.length, 2);
});

test('closed, manually navigated and edited tabs recover automatically without touching user work', async () => {
  for (const kind of ['closed', 'navigated', 'edited']) {
    const c = await companion(); await c.capture();
    const prior = c.store.readerTab.id;
    if (kind === 'closed') { c.tabs.delete(prior); await c.listeners.removed(prior); }
    if (kind === 'navigated') c.tabs.get(prior).url = 'https://qbo.intuit.com/app/bill?txnId=2';
    if (kind === 'edited') c.tabs.get(prior).dirty = true;
    const result = await c.capture();
    assert.equal(result.error, undefined, kind); assert.notEqual(c.store.readerTab.id, prior);
    assert.equal(c.actions.navigated.filter((a) => a.id === prior).length, 1, 'prior tab is left untouched');
  }
});

test('worker restart reuses owned tabs; extension reload reconnects app and recreates reader without enablement', async () => {
  const first = await companion(); await first.capture();
  const resumed = await companion({ store: first.store, tabs: first.tabs });
  assert.equal((await resumed.capture()).error, undefined);
  assert.equal(resumed.actions.created.length, 0);
  const reloaded = await companion();
  reloaded.listeners.installed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(reloaded.actions.injected.some((a) => a.id === 10 && a.file === 'bridge.js'));
  assert.equal((await reloaded.status()).ready, true);
  assert.equal((await reloaded.capture()).error, undefined);
  assert.equal(reloaded.actions.created.length, 1);
});

test('wrong company and missing columns remain explicit failures', async () => {
  const wrong = await companion({ realmId: '999999' });
  assert.match((await wrong.capture()).error, /different QuickBooks company/);
  assert.equal(wrong.actions.navigated.length, 0);
  const missing = await companion({ readError: true });
  assert.match((await missing.capture()).error, /Requested column is absent/);
});

test('app bridge reinjection replaces the old handler and ignores obsolete protocol replies', async () => {
  const handlers = new Map(); let messages = 0; const results = [];
  const window = {
    addEventListener: (name, fn, opts) => { const list = handlers.get(name) || []; list.push({ fn, once: opts?.once }); handlers.set(name, list); },
    removeEventListener: (name, fn) => { handlers.set(name, (handlers.get(name) || []).filter((h) => h.fn !== fn)); },
    dispatchEvent: (e) => { for (const h of [...(handlers.get(e.type) || [])]) { if (h.once) window.removeEventListener(e.type, h.fn); h.fn(e); } },
    postMessage: (m) => results.push(m),
  };
  const context = { window, Event, chrome: { runtime: { id: 'extension', sendMessage: async () => { messages++; return { ready: true }; } } } };
  const script = await fs.readFile(path.join(base, 'bridge.js'), 'utf8');
  vm.runInNewContext(script, context); vm.runInNewContext(script, context);
  window.dispatchEvent({ type: 'message', source: window, origin: 'http://localhost:5173', data: { type: 'tdl-screen-status', protocolVersion: 2, messageId: 'test' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages, 1); assert.equal(results[0].protocolVersion, 2);
  window.dispatchEvent({ type: 'message', source: window, origin: 'http://localhost:5173', data: { type: 'tdl-screen-status', messageId: 'legacy' } });
  assert.equal(messages, 1);
});

test('screen capture waits for delayed app shortcut and PO fields, but remains bounded', async () => {
  const delayed = await companion({ identityDelayMs: 8000, readDelayAttempts: 20 });
  const result = await delayed.capture();
  assert.equal(result.error, undefined); assert.equal(result.evidence.rows[0].value, 5);
  const unavailable = await companion({ identityDelayMs: 50000 });
  assert.match((await unavailable.capture()).error, /Company ID dialog could not be read/);
  assert.equal(unavailable.actions.navigated.length, 0);
});

test('QBO checks render in the owned visible tab and restore only an untouched initiating case', async () => {
  const c = await companion({ requireVisible: true });
  assert.equal((await c.capture()).error, undefined);
  assert.equal(c.tabs.get(10).active, true);
  assert.deepEqual(c.actions.focused, [10]);
  assert.equal((await c.capture()).error, undefined);
  assert.deepEqual(c.actions.focused, [10, c.store.readerTab.id, 10]);
  const switched = await companion({ userSwitch: true });
  assert.equal((await switched.capture()).error, undefined);
  assert.equal(switched.actions.focused.includes(10), false, 'do not override a subsequent user tab choice');
});

test('foreground capture returns to prior selection and never overrides a switch during cleanup', async () => {
  const tabs = new Map([[99, { id: 99, windowId: 1, active: true, url: 'https://example.test/' }],
    [10, { id: 10, windowId: 1, active: false, url: 'http://localhost:5173/cases/test' }]]);
  const backgroundCase = await companion({ tabs, requireVisible: true });
  assert.equal((await backgroundCase.capture()).error, undefined);
  assert.equal(tabs.get(99).active, true); assert.equal(tabs.get(10).active, false);
  const switched = await companion({ switchDuringRestore: true });
  assert.equal((await switched.capture()).error, undefined);
  assert.equal(switched.actions.focused.includes(10), false);
});

test('early injection failure preserves focus when interaction state cannot be verified', async () => {
  const c = await companion({ injectFailure: true });
  assert.match((await c.capture()).error, /Injection failed/);
  assert.equal(c.actions.focused.includes(10), false, 'unknown interaction state is not treated as untouched');
});
