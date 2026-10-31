const { randomBytes } = require('node:crypto')
const historicalJwt = 'dev-jwt-secret-change-in-production'
const suppliedJwt = process.env.JWT_SECRET
const privateJwtConfigured = typeof suppliedJwt === 'string' && suppliedJwt.trim() === suppliedJwt && Buffer.byteLength(suppliedJwt) >= 32 && Buffer.byteLength(suppliedJwt) <= 4096 && suppliedJwt !== historicalJwt
const privateJwt = privateJwtConfigured ? suppliedJwt : randomBytes(48).toString('base64url')

function enabled(name, defaultValue = false) {
  if (process.env[name] === undefined) return defaultValue
  return process.env[name] === 'true'
}

const config = {
  port: process.env.PORT || 3001,
  host: process.env.APP_HOST || '127.0.0.1',
  security: { privateJwtConfigured, allowedOrigins: (process.env.APP_ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3001,http://127.0.0.1:3001').split(',').map(value => value.trim()).filter(Boolean) },
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/qbo-support-lab',
  // Import-only fixtures use one process-private key. Explicit startup refuses it.
  jwtSecret: privateJwt,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  devAccess: {
    enabled: false,
    email: 'tester@testdatalab.local',
    displayName: 'Local Tester',
  },
  qbo: {
    clientId: process.env.QBO_CLIENT_ID || '',
    clientSecret: process.env.QBO_CLIENT_SECRET || '',
    redirectUri: process.env.QBO_REDIRECT_URI || 'http://localhost:3001/api/qbo/callback',
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
  },
  ai: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    modelFast: process.env.AI_MODEL_FAST || 'claude-sonnet-5-5',
    modelDeep: process.env.AI_MODEL_DEEP || 'claude-opus-5-5',
    // Room for a tool-using turn (several tool calls plus reasoning text). Stays
    // under the SDK's 10-minute non-streaming estimate (about 21,000 tokens).
    maxTokens: parseInt(process.env.AI_MAX_TOKENS) || 16000,
    maxToolRounds: parseInt(process.env.AI_MAX_TOOL_ROUNDS) || 10,
    // Feature flags — control which API key source is available
    //   AI_GLOBAL_KEY_ENABLED=true  → all users share the server ANTHROPIC_API_KEY
    //   AI_USER_KEYS_ENABLED=true   → each user supplies their own key (default on)
    // Both can be enabled simultaneously (user key takes priority).
    globalKeyEnabled: process.env.AI_GLOBAL_KEY_ENABLED === 'true',
    userKeysEnabled: process.env.AI_USER_KEYS_ENABLED !== 'false', // default true
    // Which model service the AI assistant uses:
    //   auto      -> Codex CLI when it is installed and signed in, else Anthropic key
    //   codex     -> always the Codex CLI (owner's ChatGPT subscription, no API key)
    //   anthropic -> always an Anthropic API key
    provider: ['auto', 'codex', 'anthropic'].includes(process.env.AI_PROVIDER) ? process.env.AI_PROVIDER : 'auto',
    codex: {
      cliPath: process.env.CODEX_CLI_PATH || null,
      model: process.env.CODEX_MODEL || 'gpt-6.1-sol',
      effort: process.env.CODEX_REASONING_EFFORT || 'medium',
      timeoutMs: parseInt(process.env.CODEX_TIMEOUT_MS) || 300000,
    },
  },
  features: {
    rebuildReadOnly: enabled('REBUILD_READ_ONLY_ENABLED', true),
    experimental: {
      aiMutations: enabled('LEGACY_AI_MUTATIONS_ENABLED', false),
      issuePackMutations: enabled('LEGACY_ISSUEPACK_MUTATIONS_ENABLED', false),
    },
    legacyStartupMaintenance: enabled('LEGACY_STARTUP_MAINTENANCE_ENABLED', false),
    // General governed QuickBooks writes (manageQboRecord, general-write-v1). Off until the
    // live transport and day-close verification of general records pass review.
    generalWriteDispatch: enabled('GENERAL_WRITE_DISPATCH_ENABLED', false),
    generalWriteInventory: enabled('GENERAL_WRITE_INVENTORY_ENABLED', false),
    generalWriteInventoryEntities: {
      Invoice: enabled('GENERAL_WRITE_INVENTORY_INVOICE_ENABLED', true),
      SalesReceipt: enabled('GENERAL_WRITE_INVENTORY_SALES_RECEIPT_ENABLED', true),
      Bill: enabled('GENERAL_WRITE_INVENTORY_BILL_ENABLED', true),
      Purchase: enabled('GENERAL_WRITE_INVENTORY_PURCHASE_ENABLED', true),
      PurchaseOrder: enabled('GENERAL_WRITE_INVENTORY_PURCHASE_ORDER_ENABLED', true),
      Estimate: enabled('GENERAL_WRITE_INVENTORY_ESTIMATE_ENABLED', true),
      // No independently verified Canadian adjustment/return valuation contract yet.
      CreditMemo: false, RefundReceipt: false, Item: false, InventoryAdjustment: false,
    },
  },
};

module.exports = config;
