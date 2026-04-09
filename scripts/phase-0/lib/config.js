const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const config = {
  clientId: process.env.QBO_CLIENT_ID,
  clientSecret: process.env.QBO_CLIENT_SECRET,
  redirectUri: process.env.QBO_REDIRECT_URI || 'http://localhost:3000/callback',
  environment: process.env.QBO_ENVIRONMENT || 'sandbox',
  realmId: process.env.QBO_REALM_ID,
  tokensPath: path.resolve(__dirname, '../../../.tokens.json'),
};

const baseUrl = config.environment === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

config.apiBase = `${baseUrl}/v3/company/${config.realmId}`;

// Validate required config
const required = ['clientId', 'clientSecret', 'realmId'];
for (const key of required) {
  if (!config[key]) {
    console.error(`Missing required env var for: ${key}`);
    process.exit(1);
  }
}

module.exports = config;
