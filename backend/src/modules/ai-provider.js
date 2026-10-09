const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('../config');
const codexCli = require('./codex-cli');
const { providerTimeout } = require('./ai-provider-timeout');

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
 * Priority: explicit per-request key > user's stored key (when user keys are
 * enabled) > global key. A stored user key is ignored, not an error, while user
 * keys are disabled, so the global key still answers.
 *
 * @param {Object} options - { apiKey?, userApiKey? }
 * @returns {string} The resolved API key
 */
function resolveApiKey(options = {}) {
  // 1. Explicit key passed in options (e.g. for testing)
  if (options.apiKey) return options.apiKey;

  // 2. Per-user key
  if (options.userApiKey && config.ai.userKeysEnabled) return options.userApiKey;

  // 3. Global server key
  if (config.ai.globalKeyEnabled && config.ai.anthropicApiKey) {
    return config.ai.anthropicApiKey;
  }

  throw Object.assign(new Error(
    'No AI API key available. ' +
    (config.ai.userKeysEnabled
      ? 'Please add your Anthropic API key in Settings.'
      : options.userApiKey
        ? 'Personal API keys are turned off on this server and no server key is set. Ask the administrator to enable AI_USER_KEYS_ENABLED or set a server key.'
        : 'AI features are currently disabled.')
  ), { aiProvider: true });
}

// Model calls (never tool calls) are retried on overload, rate limit, server and
// network errors. A timeout is not retried: the call already used its budget.
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const timing = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

function isRetryable(error) {
  if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  const status = Number(error?.status);
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

function retryDelayMs(error, attempt) {
  const header = error?.headers && typeof error.headers.get === 'function' ? error.headers.get('retry-after') : null;
  const seconds = header === null || header === undefined || header === '' ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 20000);
  return Math.min(1000 * 3 ** (attempt - 1), 10000) * (1 - Math.random() * 0.25);
}

/**
 * Turn a final Anthropic error into a plain-English one that says what to do.
 * The HTTP status is kept (routes never answer 401/403 with an app 401).
 */
function friendlyError(error, { attempts = 1, model } = {}) {
  if (!(error instanceof Anthropic.APIError)) return error;
  const status = Number(error.status);
  const detail = String(error.error?.error?.message || error.message || '').slice(0, 300);
  const tried = attempts > 1 ? ` (tried ${attempts} times)` : '';
  let message;
  if (error instanceof Anthropic.APIConnectionError) {
    message = `Could not reach the Anthropic model service${tried}. Check this computer's internet connection or proxy, then try again.`;
  } else if (status === 401) {
    message = 'The Anthropic API key was rejected. Check or replace the key in Settings (or the server ANTHROPIC_API_KEY), then try again.';
  } else if (status === 403) {
    message = "This Anthropic API key is not allowed to make this request. Check the key's workspace and model access in the Anthropic Console.";
  } else if (status === 404) {
    message = `The model "${model}" was not found for this API key. Set AI_MODEL_FAST / AI_MODEL_DEEP to a current Claude model and restart the backend.`;
  } else if (/credit balance/i.test(detail)) {
    message = 'The Anthropic account is out of credit. Add credit in the Anthropic Console (Plans & Billing), then try again.';
  } else if (status === 413 || /prompt is too long|too many tokens|context window/i.test(detail)) {
    message = 'The conversation is too long for the model. Start a new case or shorten the request.';
  } else if (status === 429) {
    message = `The Anthropic API rate limit was reached${tried}. Wait a minute and try again; if it keeps happening, check this key's usage limits in the Anthropic Console.`;
  } else if (status === 529) {
    message = `Anthropic's model service is overloaded right now${tried}. Wait a few minutes and try again.`;
  } else if (status >= 500) {
    message = `Anthropic's model service had an error (HTTP ${status})${tried}. Try again in a few minutes; check status.anthropic.com if it continues.`;
  } else {
    message = `The model service refused the request (HTTP ${status}): ${detail || 'no detail given'}.`;
  }
  return Object.assign(new Error(message), {
    aiProvider: true, status: Number.isInteger(status) ? status : 503, code: 'AI_PROVIDER_ERROR', attempts, cause: error,
  });
}

/**
 * Send a chat message to Claude and get a complete response.
 * Retries overload, rate-limit, server and network failures up to three
 * attempts in total, within options.timeoutMs when one is given.
 * @param {Array} messages - Anthropic messages format [{role, content}]
 * @param {Array} tools - Tool definitions in Anthropic format
 * @param {Object} options - { model, maxTokens, system, timeoutMs?, apiKey?, userApiKey? }
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

  const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    const remaining = deadline === null ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) throw providerTimeout('The model service', options.timeoutMs);
    try {
      return await client.messages.create(params, remaining === undefined ? { maxRetries: 0 } : { timeout: remaining, maxRetries: 0 });
    } catch (error) {
      if (deadline !== null && error instanceof Anthropic.APIConnectionTimeoutError) throw providerTimeout('The model service', options.timeoutMs);
      const delay = retryDelayMs(error, attempt);
      // Leave the retried call at least five seconds to answer.
      const fits = deadline === null || deadline - Date.now() - delay > 5000;
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error) || !fits) throw friendlyError(error, { attempts: attempt, model: params.model });
      console.warn('[ai-provider] model call failed; retrying', { attempt, status: error?.status ?? 'network', delayMs: Math.round(delay) });
      await timing.sleep(delay);
    }
  }
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

// When the Codex CLI last reported itself installed and signed in. In auto mode
// a failed `codex login status` (slow start, timeout) within this window keeps
// Codex rather than silently switching the run to an Anthropic key.
const CODEX_LAST_GOOD_MS = 10 * 60 * 1000;
const providerMemory = { codexOkAt: 0 };

/**
 * Decide which model service answers: the Codex CLI (owner's ChatGPT
 * subscription) or an Anthropic API key. See config.ai.provider.
 * Resolve once per run and pass the result back as { provider } so every pass
 * of that run uses the same service.
 * @param {{ provider?: 'codex'|'anthropic' }} [options] - an already resolved provider
 * @returns {Promise<'codex'|'anthropic'>}
 */
async function resolveProvider(options = {}) {
  if (options.provider === 'codex' || options.provider === 'anthropic') return options.provider;
  if (config.ai.provider === 'anthropic') return 'anthropic';
  if (config.ai.provider === 'codex') return 'codex';
  let status = await codexCli.getStatus();
  // A sign-in check can fail transiently; check once more before deciding.
  if (status.installed && !status.loggedIn) status = await codexCli.getStatus({ refresh: true });
  if (status.installed && status.loggedIn) {
    providerMemory.codexOkAt = Date.now();
    return 'codex';
  }
  if (status.installed && Date.now() - providerMemory.codexOkAt < CODEX_LAST_GOOD_MS) {
    console.warn('[ai-provider] Codex sign-in check failed; keeping Codex from its last good check');
    return 'codex';
  }
  return 'anthropic';
}

/**
 * Plain text completion (no tools) on whichever provider is active.
 * @param {Object} options - { system, prompt, maxTokens?, userApiKey?, provider? }
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
 */
async function complete({ system, prompt, maxTokens, userApiKey, provider } = {}) {
  if (await resolveProvider({ provider }) === 'codex') {
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

module.exports = {
  chat, stream, complete, resolveProvider, MODELS, resolveApiKey, getKeyConfig,
  // Test seams: client cache, retry timing and decision helpers.
  _internal: { clientCache, timing, providerMemory, isRetryable, friendlyError },
};
