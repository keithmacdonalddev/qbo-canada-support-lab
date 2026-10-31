'use strict';
// Persist locations only: the stack message, function arguments and record contents
// never enter the saved execution result. Re-sanitize returned worker diagnostics.
function executionDiagnostic(error) {
  const source = error?.diagnostic || error, reference = error?.referenceDiagnostic || source?.reference;
  const stack = typeof source?.stack === 'string' ? source.stack.slice(0, 12000).split(/\r?\n/).flatMap(line => {
    const match = /^(?:\s*at (?:.*?\()?|)((?:[A-Za-z]:[\\/]|\/|file:\/\/\/)[^()\r\n]*?\.(?:[cm]?js|jsx|tsx?):\d+:\d+)\)?\s*$/.exec(line);
    return match ? [match[1]] : [];
  }).reduce((text, location) => text.length + location.length + (text ? 1 : 0) <= 2000 ? text + (text ? '\n' : '') + location : text, '') : '';
  const safeReference = reference ? { observationSource: ['live', 'mirror', 'saved', 'unknown'].includes(reference.observationSource) ? reference.observationSource : 'unknown', definitionVersion: [1, 2].includes(reference.definitionVersion) ? reference.definitionVersion : null, definitionObservationPresent: reference.definitionObservationPresent === true, retainedDefinitionResolved: reference.retainedDefinitionResolved === true } : null;
  return stack || safeReference ? { stack, ...(safeReference ? { reference: safeReference } : {}) } : null;
}
module.exports = { executionDiagnostic };
