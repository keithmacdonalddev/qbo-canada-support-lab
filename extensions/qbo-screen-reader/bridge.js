// Only the local app can ask the fixed companion reader for evidence.
(() => {
  const replacement = 'tdl-screen-bridge-replaced-v2';
  window.dispatchEvent(new Event(replacement));
  const onMessage = async (event) => {
    if (event.source !== window || event.origin !== 'http://localhost:5173') return;
    const message = event.data;
    if (!message || !['tdl-screen-status', 'tdl-screen-capture'].includes(message.type)
        || message.protocolVersion !== 2 || typeof message.messageId !== 'string'
        || message.messageId.length > 80 || JSON.stringify(message).length > 26000) return;
    try {
      const result = await chrome.runtime.sendMessage(message);
      window.postMessage({ type: 'tdl-screen-result', protocolVersion: 2, messageId: message.messageId, result }, event.origin);
    } catch {
      // A replacement bridge reconnects after reload. An invalid old context
      // must not race the new bridge with a false disconnected response.
      if (chrome.runtime?.id) window.postMessage({ type: 'tdl-screen-result', protocolVersion: 2, messageId: message.messageId,
        result: { ready: false, error: 'The screen reader is reconnecting.' } }, event.origin);
    }
  };
  window.addEventListener('message', onMessage);
  window.addEventListener(replacement, () => window.removeEventListener('message', onMessage), { once: true });
})();
