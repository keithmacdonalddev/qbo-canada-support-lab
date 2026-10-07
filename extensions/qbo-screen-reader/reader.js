/* Fixed DOM reader. No fetch, page state, cookies, arbitrary selectors or writes. */
(function (global) {
  const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && el.getClientRects().length > 0 && (el.checkVisibility
    ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : getComputedStyle(el).visibility !== 'hidden');
  const text = (el) => {
    if (!visible(el)) return '';
    const controls = [...el.querySelectorAll('input,textarea,select')].filter(visible);
    if (controls.length > 1) throw new Error('A screen cell contains several visible values.');
    return normalize(controls.length ? controls[0].value : el.innerText);
  };
  function labelledValue(pattern) {
    const matches = [];
    for (const el of document.querySelectorAll('input,textarea')) {
      if (!visible(el)) continue;
      const label = normalize(el.getAttribute('aria-label') || Array.from(el.labels || []).map((l) => l.innerText).join(' '));
      if (pattern.test(label)) matches.push(normalize(el.value));
    }
    return matches.length === 1 ? matches[0] : null;
  }
  function guard() {
    if (global.__tdlScreenGuard) return;
    global.__tdlScreenGuard = { dirty: false };
    // Button-only edits (for example removing a line) need not emit input/change.
    // Any real user interaction hands this tab back to the user. Our fixed
    // identity shortcut uses untrusted synthetic events and does not set this.
    for (const type of ['input', 'change', 'pointerdown', 'keydown']) {
      document.addEventListener(type, (e) => { if (e.isTrusted) global.__tdlScreenGuard.dirty = true; }, true);
    }
  }
  function identity() {
    const dialogs = [...document.querySelectorAll('[role="dialog"],dialog')].filter(visible);
    const info = dialogs.filter((d) => {
      const title = normalize(d.getAttribute('aria-label') || document.getElementById(d.getAttribute('aria-labelledby'))?.innerText || d.querySelector('h1,h2,[role=heading]')?.innerText);
      return /^(Company information|Company info|About QuickBooks|QuickBooks Online|Company ID|Company ID and keyboard shortcuts)$/i.test(title);
    });
    const ids = info.map((d) => normalize(d.innerText).match(/Company\s*ID\s*(?:is\s*)?[:#]?\s*([\d -]{6,30})/i)?.[1]?.replace(/\D/g, '')).filter(Boolean);
    return ids.length === 1 ? ids[0] : null;
  }
  function shortcut(open) {
    document.dispatchEvent(new KeyboardEvent('keydown', open
      ? { key: '?', code: 'Slash', keyCode: 191, which: 191, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true }
      : { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  }
  function read(request) {
    if (global.__tdlScreenGuard?.dirty) throw new Error('This QuickBooks tab has user edits. Use a dedicated tab for screen checks.');
    if ([...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible)) throw new Error('QuickBooks is still loading.');
    const url = new URL(location.href);
    if (url.pathname !== '/app/purchaseorder' || url.searchParams.get('txnId') !== request.id) throw new Error('The requested purchase order is not open.');
    const docNumber = labelledValue(/^(?:Purchase order|P\.?O\.?)\s*(?:no\.?|number|#)$/i);
    if (docNumber !== request.docNumber) throw new Error('The visible purchase order number could not be verified.');
    const column = request.field === 'receivedQuantity' ? /^Received$/i : /^(Billed|Billed quantity|Billed qty|Qty billed)$/i;
    const candidates = [];
    for (const table of [...document.querySelectorAll('table,[role="grid"],[role="table"]')].filter(visible)) {
      const rows = [...table.querySelectorAll('tr,[role="row"]')].filter(visible);
      const header = rows.find((r) => [...r.querySelectorAll('th,[role="columnheader"]')].some((c) => column.test(text(c))));
      if (!header) continue;
      const headers = [...header.querySelectorAll('th,[role="columnheader"]')].map(text);
      const index = (pattern) => headers.findIndex((s) => pattern.test(s));
      const headerCells = [...header.querySelectorAll('th,[role="columnheader"]')];
      const b = index(column);
      const q = index(/^(Qty|Quantity)$/i);
      const item = index(/^(Product\s*\/\s*Service|Item)$/i);
      const desc = index(/^Description$/i);
      if (b < 0 || q < 0 || item < 0 || ![b, q, item].every((i) => visible(headerCells[i]))) continue;
      if (headers.filter((s) => column.test(s)).length !== 1) continue;
      const values = [];
      let invalid = false;
      for (const row of rows.filter((r) => r !== header)) {
        const cells = [...row.querySelectorAll('td,[role="gridcell"],[role="cell"]')];
        if (!cells.length) continue;
        const product = text(cells[item]);
        if (!product && !text(cells[q]) && !text(cells[b])) continue;
        if (![b, q, item].every((i) => visible(cells[i]))) { invalid = true; break; }
        const qty = text(cells[q]);
        const billed = text(cells[b]);
        if (!product || !/^\d+(?:\.\d+)?$/.test(qty) || !/^\d+(?:\.\d+)?$/.test(billed)) { invalid = true; break; }
        values.push({ item: product, description: desc < 0 ? '' : text(cells[desc]), quantity: Number(qty), label: headers[b], text: billed, value: Number(billed) });
      }
      if (!invalid && values.length === request.lines.length) candidates.push(values);
    }
    if (candidates.length !== 1) throw new Error('A complete, unambiguous requested quantity column was not visible. This page layout is not yet supported.');
    return { entityType: 'PurchaseOrder', id: request.id, field: request.field || 'billedQuantity', readerVersion: 1,
      docNumber, rows: candidates[0], url: location.href, capturedAt: Date.now() };
  }
  global.TDLScreenReader = { guard, identity, shortcut, read };
  guard();
})(globalThis);
