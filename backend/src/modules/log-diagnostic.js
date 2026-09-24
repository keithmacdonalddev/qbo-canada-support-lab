/** Preserve error detail in local logs without echoing credentials. */
function redactLogSecrets(value) {
  return String(value ?? '')
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s@/]+@/gi, '$1[redacted]@')
    .replace(/:\/\/[^\s:/]+:[^\s@/]+@/g, '://[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b([a-z0-9_-]*(?:secret|token|password|passwd|pwd|api[-_]?key|authorization))\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,"';}]+)/gi, '$1=[redacted]')
    .replace(/([?&](?:code|state|token|key|client_secret|access_token|refresh_token)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]')
    .replace(/\b(?:sk|key)-[a-z0-9_-]{12,}\b/gi, '[redacted key]');
}

module.exports = { redactLogSecrets };
