'use strict';

// Gives a Codex CLI run this app's AI tools through MCP (the standard way to
// hand tools to these programs). Each run gets its own random session token,
// kept only in memory and passed to Codex in an environment variable. A call
// goes through the run's own `execute` function, so the same read/confirm
// rules, company scope and audit logging apply as on the Anthropic path.
// Adapted from the owner's Alfred app (server/src/services/native-tool-bridge.js).

const { randomBytes } = require('crypto');
const config = require('../config');
const { bindActor } = require('./actor-context');

const SERVER_NAME = 'testdatalab';
const TOKEN_ENV = 'TEST_DATA_LAB_TOOL_TOKEN';
const SESSION_MARGIN_MS = 60 * 1000;
const DEFAULT_MAX_CALLS = 40;
const sessions = new Map();

function bridgeUrl() {
  return `http://127.0.0.1:${config.port}/api/ai-tools/mcp`;
}

/**
 * @param {Object} options
 * @param {Array} options.tools - Anthropic-format tool definitions
 * @param {(name: string, input: Object) => Promise<Object>} options.execute
 * @param {number} [options.maxAgeMs] - defaults to the Codex timeout plus a margin
 * @param {number} [options.maxCalls] - tool calls allowed per run
 */
function createToolSession({
  tools,
  execute,
  maxAgeMs = config.ai.codex.timeoutMs + SESSION_MARGIN_MS,
  maxCalls = DEFAULT_MAX_CALLS,
}) {
  const token = randomBytes(32).toString('hex');
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let queue = Promise.resolve();
  let revoked = false;
  let calls = 0;
  let listed = 0;
  const expiresAt = Date.now() + maxAgeMs;

  // Tool calls arrive on the MCP request, not the one that started the run;
  // keep the starting request's actor for their audit entries.
  const executeAsActor = bindActor(execute);

  const session = {
    get active() { return !revoked && Date.now() < expiresAt; },
    // How often Codex asked for the tool list and called a tool, so a run
    // that had tools but never saw or used them can be detected.
    stats() { return { listed, calls }; },
    listForModel() {
      listed += 1;
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema || { type: 'object', properties: {} },
      }));
    },
    has(name) { return byName.has(name); },
    // One call at a time, in arrival order, like the Anthropic loop.
    // Each read is a live QuickBooks call, so a run gets a bounded budget.
    call(name, input) {
      calls += 1;
      if (calls > maxCalls) {
        return Promise.resolve({ success: false, error: `Tool limit reached (${maxCalls} calls). Answer with what you have.` });
      }
      const runCall = queue.then(() => session.active
        ? executeAsActor(name, input || {})
        : { success: false, error: 'This tool session has ended.' });
      queue = runCall.catch(() => {});
      return runCall;
    },
    bridge: { serverName: SERVER_NAME, url: bridgeUrl(), token, tokenEnv: TOKEN_ENV, stats: () => session.stats() },
    async close() {
      session.revoke();
      await queue; // Preserve receipts from an external write already in flight.
    },
    revoke() {
      revoked = true;
      sessions.delete(token);
    },
  };
  sessions.set(token, session);
  return session;
}

function getSession(token) {
  const session = sessions.get(String(token || ''));
  if (!session) return null;
  if (!session.active) {
    session.revoke();
    return null;
  }
  return session;
}

function toolResult(id, value, isError = false) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
}

async function handleMessage(session, message) {
  const id = message?.id;
  const method = typeof message?.method === 'string' ? message.method : '';
  if (id === undefined || id === null) return null; // notification
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '1' },
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: session.listForModel() } };
  if (method === 'tools/call') {
    const name = String(message.params?.name || '');
    const input = message.params?.arguments;
    if (!session.has(name)) return toolResult(id, `Unknown tool: ${name.slice(0, 80)}. Nothing was run.`, true);
    if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
      return toolResult(id, 'Tool arguments must be an object. Nothing was run.', true);
    }
    try {
      const result = await session.call(name, input);
      return toolResult(id, result, result?.success === false);
    } catch (err) {
      return toolResult(id, `The tool failed: ${String(err?.message || 'unknown error').slice(0, 300)}`, true);
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

/** Handle one HTTP body: a JSON-RPC message or a batch. */
async function handleMcpRequest(token, body) {
  const session = getSession(token);
  if (!session) return { status: 404, json: { error: 'Not found' } };
  const batch = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const message of batch) {
    const reply = await handleMessage(session, message);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return { status: 202, json: null };
  return { status: 200, json: Array.isArray(body) ? replies : replies[0] };
}

module.exports = { createToolSession, handleMcpRequest, SERVER_NAME, TOKEN_ENV };
