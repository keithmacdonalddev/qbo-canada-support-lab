const config = {
  port: process.env.PORT || 3001,
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/qbo-support-lab',
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  qbo: {
    clientId: process.env.QBO_CLIENT_ID || '',
    clientSecret: process.env.QBO_CLIENT_SECRET || '',
    redirectUri: process.env.QBO_REDIRECT_URI || 'http://localhost:3001/api/qbo/callback',
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
  },
  ai: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    modelFast: process.env.AI_MODEL_FAST || 'claude-sonnet-4-6',
    modelDeep: process.env.AI_MODEL_DEEP || 'claude-opus-4-6',
    maxTokens: parseInt(process.env.AI_MAX_TOKENS) || 4096,
    maxToolRounds: parseInt(process.env.AI_MAX_TOOL_ROUNDS) || 10,
    // Feature flags — control which API key source is available
    //   AI_GLOBAL_KEY_ENABLED=true  → all users share the server ANTHROPIC_API_KEY
    //   AI_USER_KEYS_ENABLED=true   → each user supplies their own key (default on)
    // Both can be enabled simultaneously (user key takes priority).
    globalKeyEnabled: process.env.AI_GLOBAL_KEY_ENABLED === 'true',
    userKeysEnabled: process.env.AI_USER_KEYS_ENABLED !== 'false', // default true
  },
};

module.exports = config;
