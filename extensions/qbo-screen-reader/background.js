const ORIGINS = { production: 'https://qbo.intuit.com', sandbox: 'https://app.sandbox.qbo.intuit.com' };
const HOSTS = Object.values(ORIGINS).map((origin) => origin + '/*');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let busy = false;
let focusGeneration = 0;
chrome.tabs.onActivated.addListener(() => { focusGeneration += 1; });
const receipts = new Map();
const errorText = (e) => e?.message?.includes('Cannot access')
  ? 'Allow the screen reader access to QuickBooks in Chrome extension settings.' : String(e.message || e).slice(0, 300);
async function permissionStatus() {
  const ready = await chrome.permissions.contains({ origins: HOSTS });
  return { ready, mode: 'automatic', ...(ready ? {} : { error: 'Allow QuickBooks site access for Test Data Lab Screen Reader in Chrome extension settings.' }) };
}
async function ownedTab(pendingTarget = null) {
  const { readerTab } = await chrome.storage.session.get('readerTab');
  if (!readerTab || !Number.isInteger(readerTab.id)) throw new Error('The automatic reader tab is no longer available.');
  const tab = await chrome.tabs.get(readerTab.id);
  if (pendingTarget === readerTab.url && tab.pendingUrl === readerTab.url && tab.status === 'loading') return tab;
  if (tab.url !== readerTab.url) throw new Error('The reader tab was navigated manually.');
  if (!Object.values(ORIGINS).includes(new URL(tab.url).origin)) throw new Error('QuickBooks needs sign-in in the reader tab.');
  return tab;
}
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['reader.js'] });
}
async function call(tabId, method, request) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, func: (name, data) => {
    try {
      let value;
      if (name === 'identity') value = globalThis.TDLScreenReader.identity();
      else if (name === 'openIdentity') value = globalThis.TDLScreenReader.shortcut(true);
      else if (name === 'closeIdentity') value = globalThis.TDLScreenReader.shortcut(false);
      else if (name === 'read') value = globalThis.TDLScreenReader.read(data);
      else if (name === 'dirty') value = globalThis.__tdlScreenGuard?.dirty !== false;
      else throw new Error('Unsupported reader operation.');
      return { ok: true, value: value ?? null };
    } catch (err) { return { ok: false, error: String(err.message || err).slice(0, 300) }; }
  }, args: [method, request || null] });
  if (result.length !== 1 || !result[0].result) throw new Error('The main QuickBooks frame could not be read.');
  if (!result[0].result.ok) throw new Error(result[0].result.error || 'The requested screen value was unavailable.');
  return result[0].result.value;
}
async function waitForTab(id, url, expiresAt) {
  const deadline = Math.min(Date.now() + 20000, expiresAt - 10000);
  while (Date.now() < deadline) {
    const tab = await ownedTab(url);
    if (tab.id !== id) throw new Error('The automatic reader tab changed during the check.');
    if (tab.status === 'complete' && tab.url === url) return tab;
    await delay(250);
  }
  throw new Error('QuickBooks did not finish loading before the screen check expired.');
}
async function automaticTab(request, windowId, acquired) {
  const origin = ORIGINS[request.environment];
  try {
    const tab = await ownedTab();
    if (new URL(tab.url).origin === origin && tab.status === 'complete' && tab.windowId === windowId) {
      // Inspect the existing guard BEFORE injection. A manually reloaded page
      // loses the guard; never assume an existing page without it is unedited.
      if (!await call(tab.id, 'dirty')) {
        // QBO may defer its transaction UI entirely in a hidden tab.
        acquired(tab.id);
        await chrome.tabs.update(tab.id, { active: true });
        return tab;
      }
    }
  } catch { /* Lost, redirected, edited or reloaded tabs are left untouched. */ }
  await authorize(request.nonce, 'validate');
  const url = origin + '/app/homepage';
  const tab = await chrome.tabs.create({ url, active: true, windowId });
  acquired(tab.id);
  await chrome.storage.session.set({ readerTab: { id: tab.id, url } });
  await waitForTab(tab.id, url, request.expiresAt);
  await inject(tab.id);
  return tab;
}
async function companyId(tabId, expiresAt) {
  // Browser load completion does not mean the QBO app has installed its
  // shortcut handler. Retry the fixed shortcut while waiting for its dialog.
  const deadline = Math.min(Date.now() + 15000, expiresAt - 8000);
  let id;
  let nextShortcut = 0;
  while (Date.now() < deadline) {
    if (await call(tabId, 'dirty')) throw new Error('The reader tab contains manual interaction. It was left untouched.');
    id = await call(tabId, 'identity');
    if (id) break;
    if (Date.now() >= nextShortcut) {
      await call(tabId, 'openIdentity');
      nextShortcut = Date.now() + 1000;
    }
    await delay(250);
  }
  if (!id) throw new Error('The QuickBooks Company ID dialog could not be read. Company identity remains unverified.');
  await call(tabId, 'closeIdentity');
  return id;
}
async function reconnectApp() {
  // Reload/update can invalidate old content-script contexts. Reattach only to
  // the local app; this neither reads QBO nor starts a case.
  const tabs = await chrome.tabs.query({ url: 'http://localhost:5173/*' });
  await Promise.allSettled(tabs.map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['bridge.js'] })));
}
async function refreshStatus() {
  const status = await permissionStatus();
  await chrome.action.setBadgeText({ text: status.ready ? 'ON' : '!' });
  await chrome.action.setTitle({ title: status.ready ? 'Automatic screen checks ready. No tab enablement needed.' : status.error });
}
const refresh = () => { refreshStatus().catch(() => {}); reconnectApp().catch(() => {}); };
chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(() => { refreshStatus().catch(() => {}); });
chrome.action.onClicked.addListener(() => { refreshStatus().catch(() => {}); });
chrome.tabs.onRemoved.addListener(async (id) => {
  const { readerTab } = await chrome.storage.session.get('readerTab');
  if (readerTab?.id === id) await chrome.storage.session.remove('readerTab');
});
async function authorize(nonce, stage) {
  const response = await fetch('http://localhost:5173/api/screen-reader/capability', {
    method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, stage }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('The server did not authorize this screen check, or the case stopped.');
  return (await response.json()).request;
}
async function capture(proposed, caller) {
  const request = await authorize(proposed?.nonce, 'redeem');
  if (!request || request.entityType !== 'PurchaseOrder' || !['billedQuantity', 'receivedQuantity'].includes(request.field)
      || !/^\d+$/.test(request.id) || !/^\d+$/.test(request.realmId) || !ORIGINS[request.environment]
      || typeof request.docNumber !== 'string' || !Array.isArray(request.lines) || !request.lines.length
      || request.lines.length > 100 || typeof request.nonce !== 'string' || request.nonce.length !== 36
      || !Number.isFinite(request.expiresAt) || Date.now() > request.expiresAt
      || request.expiresAt - Date.now() > 60000) throw new Error('Invalid or expired screen request.');
  if (busy) throw new Error('Another screen check is in progress.');
  busy = true;
  let readerId;
  let previousTabId;
  try {
    const status = await permissionStatus();
    if (!status.ready) throw new Error(status.error);
    // Foreground rendering is part of an authorized check, even while the
    // case is in the background. Remember the user's prior selection, not
    // just the case tab, so we can return to it without adopting its contents.
    const previous = await chrome.tabs.query({ active: true, windowId: caller.windowId });
    previousTabId = previous[0]?.id;
    let tab = await automaticTab(request, caller.windowId, (id) => { readerId = id; });
    const enabledId = tab.id;
    const origin = ORIGINS[request.environment];
    if (await call(tab.id, 'dirty')) throw new Error('The reader tab contains manual edits. It was left untouched.');
    if (await companyId(tab.id, request.expiresAt) !== request.realmId) throw new Error('The reader tab is in a different QuickBooks company.');
    const url = origin + '/app/purchaseorder?txnId=' + request.id;
    await authorize(request.nonce, 'validate');
    await ownedTab();
    if (await call(tab.id, 'dirty')) throw new Error('Manual edits were detected. The reader did not navigate away.');
    // Always navigate, including the same PO: linked bills may have changed
    // through the API since the last capture, leaving the open DOM stale.
    await chrome.storage.session.set({ readerTab: { id: tab.id, url } });
    await chrome.tabs.update(tab.id, { url });
    tab = await waitForTab(tab.id, url, request.expiresAt);
    await inject(tab.id);
    let evidence;
    let lastError;
    for (let i = 0; i < 60 && Date.now() < request.expiresAt - 8000; i += 1) {
      try { evidence = await call(tab.id, 'read', request); break; }
      catch (err) { lastError = err; await delay(500); }
    }
    if (!evidence) throw lastError || new Error('The purchase order was not ready.');
    const realmId = await companyId(tab.id, request.expiresAt);
    if (realmId !== request.realmId) throw new Error('QuickBooks company changed during the screen check.');
    // Re-read after identity inspection; never attach an old cell to a new page.
    evidence = await call(tab.id, 'read', request);
    if ((await ownedTab()).id !== enabledId) throw new Error('The enabled tab changed.');
    await authorize(request.nonce, 'validate');
    return { evidence: { ...evidence, realmId } };
  } finally {
    // Return to the previous selection only while the reader still owns
    // focus. A tab switch during asynchronous guard checks cancels restoration.
    try {
      if (readerId && previousTabId && previousTabId !== readerId) {
        const generation = focusGeneration;
        const previous = await chrome.tabs.get(previousTabId);
        if (previous.windowId === caller.windowId && !await call(readerId, 'dirty')) {
          const reader = await chrome.tabs.get(readerId);
          if (reader.active && reader.windowId === caller.windowId && generation === focusGeneration) {
            await chrome.tabs.update(previousTabId, { active: true });
          }
        }
      }
    } catch { /* Closed tabs or unknown interaction state must not mask the result. */ }
    busy = false;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab
      || new URL(sender.url).origin !== 'http://localhost:5173') return false;
  if (message?.type === 'tdl-screen-status') {
    permissionStatus().then(respond, (err) => respond({ ready: false, error: errorText(err) }));
    return true;
  }
  if (message?.type !== 'tdl-screen-capture' || JSON.stringify(message).length > 24000) return false;
  const request = message.request;
  for (const [key, entry] of receipts) if (entry.expiresAt < Date.now()) receipts.delete(key);
  const fingerprint = JSON.stringify(request);
  let entry = receipts.get(request?.nonce);
  if (entry && entry.fingerprint !== fingerprint) { respond({ error: 'Screen request identifier was reused.' }); return false; }
  if (!entry) {
    entry = { fingerprint, expiresAt: Date.now() + 60000, promise: capture(request, { id: sender.tab.id, windowId: sender.tab.windowId, url: sender.url }).catch((err) => ({ error: errorText(err) })) };
    receipts.set(request?.nonce, entry);
  }
  entry.promise.then(respond);
  return true;
});
