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
async function generateNote(sessionData, format = 'escalation') {
  const noteFormat = NOTE_FORMATS[format];
  if (!noteFormat) throw new Error(`Invalid note format: ${format}`);

  // Build context from session findings
  const findings = extractFindings(sessionData);

  const messages = [{
    role: 'user',
    content: `Based on the following investigation findings, generate a ${noteFormat.name}.\n\n${findings}`,
  }];

  const response = await aiProvider.chat(messages, [], {
    system: noteFormat.systemPrompt,
    maxTokens: 2048,
  });

  const content = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return {
    content,
    format,
    formatName: noteFormat.name,
    generatedAt: new Date(),
    tokenUsage: response.usage,
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

module.exports = { generateNote, NOTE_FORMATS };
