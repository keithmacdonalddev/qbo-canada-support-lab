const aiProvider = require('./ai-provider');

const NOTE_FORMATS = {
  escalation: {
    name: 'Escalation Summary',
    systemPrompt: `Generate a structured escalation note. Use this exact format:

## Escalation Summary

**Issue:** [brief description]
**Severity:** [Low/Medium/High/Critical]
**Affected entities:** [list entity types and IDs]

### Root cause
[2-3 sentence explanation of what went wrong]

### Evidence
[Bulleted list of specific findings with entity IDs and amounts]

### Steps taken
[Numbered list of investigation/resolution steps]

### Recommended resolution
[Specific actionable recommendation]`,
  },
  internal: {
    name: 'Internal Note',
    systemPrompt: `Generate a concise internal handoff note. Use bullet points. Include:
- Issue summary (1 line)
- Key entities involved (IDs and amounts)
- Root cause (1-2 sentences)
- What was done / what remains
- Any gotchas for the next person`,
  },
  customer: {
    name: 'Customer-Facing Note',
    systemPrompt: `Generate a professional customer-facing note. Rules:
- Use plain language, no internal IDs or technical jargon
- Focus on what happened and what was resolved
- Be empathetic and reassuring
- Do not reference internal tools or processes
- Keep it under 200 words`,
  },
};

/**
 * Generate a support note from session findings.
 * @param {Object} sessionData - { messages, toolResults, explanation }
 * @param {string} format - 'escalation' | 'internal' | 'customer'
 * @returns {Object} { content, format, formatName, generatedAt, tokenUsage }
 */
async function generateNote(sessionData, format = 'escalation', { userApiKey } = {}) {
  const noteFormat = NOTE_FORMATS[format];
  if (!noteFormat) throw new Error(`Invalid note format: ${format}`);
  if (sessionData.reproduction) return caseNote(sessionData, format);

  // Build context from session findings
  const findings = extractFindings(sessionData);

  const messages = [{
    role: 'user',
    content: `Based on the following investigation findings, generate a ${noteFormat.name}.\n\n${findings}`,
  }];

  const completion = await aiProvider.complete({
    system: noteFormat.systemPrompt,
    prompt: messages[0].content,
    maxTokens: 2048,
    userApiKey,
  });
  const content = completion.text;

  return {
    content,
    format,
    formatName: noteFormat.name,
    generatedAt: new Date(),
    tokenUsage: completion.usage,
  };
}

/**
 * Extract findings from session data into a readable summary for note generation.
 */
function extractFindings(sessionData) {
  const parts = [];

  if (sessionData.messages) {
    for (const msg of sessionData.messages) {
      if (msg.role === 'user') {
        parts.push(`User: ${msg.content}`);
      } else if (msg.role === 'assistant' && msg.content) {
        parts.push(`Assistant: ${msg.content}`);
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          parts.push(`Tool [${tc.toolName}]: ${JSON.stringify(tc.result)}`);
        }
      }
    }
  }

  return parts.join('\n\n');
}


function caseNoteEvidence(session) {
  const run = session.reproduction || {};
  return { caseId: String(session._id), runId: run.runId || null, revision: run.revision || 0, decisionRevision: run.decisionRevision || 0,
    sourceHash: run.requestSources?.contentHash || null, contractHash: run.requestContract?.contentHash || null,
    assessmentHash: run.assessment?.contentHash || null, viewOutcome: run.outcome || null, trust: run.assessmentTrust || 'not-assessed' };
}
function matchesCaseNoteEvidence(value, expected) {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length === Object.keys(expected).length && Object.keys(expected).every(key => value[key] === expected[key]));
}
function caseNote(session, format) {
  const run = session.reproduction, review = run.assessmentReview;
  const assessed = run.assessmentTrust === 'independent-model-assessment' && review?.valid === true && review.outcome === run.outcome;
  const legacy = run.assessmentTrust === 'executor-assessed';
  const labels = { completed: 'Requested setup verified in the saved observations', reproduced: 'Reported symptom observed in the saved observations', not_reproduced: 'Reported symptom not observed in these tests', needs_input: 'Waiting for an essential operator answer', unverified: 'Result unverified' };
  const result = assessed ? labels[run.outcome] || labels.unverified : legacy ? 'Legacy assistant result: ' + (labels[run.outcome] || labels.unverified) : labels.unverified;
  const assurance = assessed ? 'Independent model assessment of retained observations; this is not a verified root cause or a guarantee of interpretation.'
    : legacy ? 'The executing assistant chose and assessed the saved checks. No independent request assessment was recorded.'
      : 'The independent evidence assessment is absent or unavailable. No verified outcome is established.';
  const setup = assessed && review.setupComplete ? 'Setup passed its required saved observations.' : 'Setup is not fully verified by the current evidence.';
  const observations = assessed ? review.requirements.map(row => '- ' + row.label + ': ' + (!row.available ? 'unavailable' : row.matched ? 'matched' : 'did not match')) : ['- The saved case does not establish a current independently assessed result.'];
  const records = (run.ownedRecords || []).slice(0, 20).map(row => row.entityType + ' #' + row.id).join(', ') || 'None listed';
  let content;
  if (format === 'customer') {
    content = (assessed ? result + '. ' + setup : 'The current evidence does not establish a verified result.') + ' The cause and any resolution remain unconfirmed. ' +
      (assessed && run.outcome === 'not_reproduced' ? 'The reported behavior did not appear in the tested sequence; this does not establish that it cannot occur.' : 'The saved observations describe the tested scenario only.');
  } else if (format === 'escalation') {
    content = '## Escalation Summary\n\n**Result:** ' + result + '\n**Severity:** Not assessed\n**Saved record references:** ' + records +
      '\n\n### Root cause\nNot established by the retained reproduction evidence.\n\n### Evidence\n' + assurance + '\n' + setup + '\n' + observations.join('\n') +
      '\n\n### Steps taken\nThe case retains its original request, action receipts and observations. This note did not create, edit, void or delete accounting records.\n\n### What remains\n' +
      (assessed && run.outcome !== 'unverified' ? 'Review the retained observations and investigate the cause before describing a resolution.' : 'Complete or recover the missing evidence in the original case; do not replay uncertain writes.');
  } else {
    content = '- Result: ' + result + '\n- Evidence status: ' + assurance + '\n- Root cause: Not established.\n- ' + setup + '\n- Saved record references: ' + records + '\n' + observations.join('\n') +
      '\n- What remains: ' + (assessed && run.outcome !== 'unverified' ? 'Investigate the cause; no resolution is established by these observations.' : 'Resolve the missing or unavailable evidence in the original case without replaying uncertain writes.');
  }
  return { content, format, formatName: NOTE_FORMATS[format].name, generatedAt: new Date(), tokenUsage: { inputTokens: 0, outputTokens: 0 },
    source: 'retained-case-evidence', evidence: { ...caseNoteEvidence(session), outcome: assessed ? run.outcome : 'unverified' } };
}

module.exports = { generateNote, NOTE_FORMATS, caseNoteEvidence, matchesCaseNoteEvidence };
