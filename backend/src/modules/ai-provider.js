const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('../config');
const codexCli = require('./codex-cli');

const MODELS = {
  FAST: config.ai.modelFast,
  DEEP: config.ai.modelDeep,
};

// Cache clients by API key to avoid creating a new instance on every call.
const clientCache = new Map();

/**
 * Get or create an Anthropic client for the given API key.
 * @param {string} apiKey
 * @returns {Anthropic}
 */
function getClient(apiKey) {
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new Anthropic({ apiKey }));
  }
  return clientCache.get(apiKey);
}

/**
 * Resolve which API key to use for a request.
 * Priority: explicit per-request key > user's stored key > global key.
 * Throws if no key is available or the relevant feature flag is off.
 *
 * @param {Object} options - { apiKey?, userApiKey? }
 * @returns {string} The resolved API key
 */
function resolveApiKey(options = {}) {
  // 1. Explicit key passed in options (e.g. for testing)
  if (options.apiKey) return options.apiKey;

  // 2. Per-user key
  if (options.userApiKey) {
    if (!config.ai.userKeysEnabled) {
      throw new Error('Per-user API keys are disabled by the administrator');
    }
    return options.userApiKey;
  }

  // 3. Global server key
  if (config.ai.globalKeyEnabled && config.ai.anthropicApiKey) {
    return config.ai.anthropicApiKey;
  }

  throw new Error(
    'No AI API key available. ' +
    (config.ai.userKeysEnabled
      ? 'Please add your Anthropic API key in Settings.'
      : 'AI features are currently disabled.')
  );
}

/**
 * Send a chat message to Claude and get a complete response.
 * @param {Array} messages - Anthropic messages format [{role, content}]
 * @param {Array} tools - Tool definitions in Anthropic format
 * @param {Object} options - { model, maxTokens, system, apiKey?, userApiKey? }
 * @returns {Object} Anthropic response object
 */
async function chat(messages, tools = [], options = {}) {
  const apiKey = resolveApiKey(options);
  const client = getClient(apiKey);

  const params = {
    model: options.model || MODELS.FAST,
    max_tokens: options.maxTokens || config.ai.maxTokens,
    messages,
  };
  if (options.system) params.system = options.system;
  if (tools.length > 0) params.tools = tools;

  const response = await client.messages.create(params);
  return response;
}

/**
 * Stream a chat response from Claude via SSE-compatible stream.
 * @param {Array} messages
 * @param {Array} tools
 * @param {Object} options - { model, maxTokens, system, apiKey?, userApiKey? }
 * @returns {AsyncIterable} Stream of events
 */
async function stream(messages, tools = [], options = {}) {
  const apiKey = resolveApiKey(options);
  const client = getClient(apiKey);

  const params = {
    model: options.model || MODELS.FAST,
    max_tokens: options.maxTokens || config.ai.maxTokens,
    messages,
  };
  if (options.system) params.system = options.system;
  if (tools.length > 0) params.tools = tools;

  const result = client.messages.stream(params);
  return result;
}

/**
 * Return the current feature-flag state for the frontend.
 */
function getKeyConfig() {
  return {
    globalKeyEnabled: config.ai.globalKeyEnabled,
    globalKeySet: !!(config.ai.globalKeyEnabled && config.ai.anthropicApiKey),
    userKeysEnabled: config.ai.userKeysEnabled,
  };
}

/**
 * Decide which model service answers: the Codex CLI (owner's ChatGPT
 * subscription) or an Anthropic API key. See config.ai.provider.
 * @returns {Promise<'codex'|'anthropic'>}
 */
async function resolveProvider() {
  if (config.ai.provider === 'anthropic') return 'anthropic';
  if (config.ai.provider === 'codex') return 'codex';
  const status = await codexCli.getStatus();
  return status.installed && status.loggedIn ? 'codex' : 'anthropic';
}

/**
 * Plain text completion (no tools) on whichever provider is active.
 * @param {Object} options - { system, prompt, maxTokens?, userApiKey? }
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
 */
async function complete({ system, prompt, maxTokens, userApiKey } = {}) {
  if (await resolveProvider() === 'codex') {
    const result = await codexCli.run({ system, prompt });
    return { text: result.text, usage: result.usage };
  }
  const response = await chat([{ role: 'user', content: prompt }], [], { system, maxTokens, userApiKey });
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return {
    text,
    usage: { inputTokens: response.usage?.input_tokens || 0, outputTokens: response.usage?.output_tokens || 0 },
  };
}

module.exports = { chat, stream, complete, resolveProvider, MODELS, resolveApiKey, getKeyConfig };
