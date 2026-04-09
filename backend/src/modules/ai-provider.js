const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('../config');

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

module.exports = { chat, stream, MODELS, resolveApiKey, getKeyConfig };
