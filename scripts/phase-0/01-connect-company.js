/**
 * 01-connect-company.js
 *
 * Tests: AUTH-01 through AUTH-04
 * Opens browser for OAuth, captures tokens, validates realm targeting.
 */
const express = require('express');
const { exec } = require('child_process');
const OAuthClient = require('intuit-oauth');
const config = require('./lib/config');
const qbo = require('./lib/qbo-client');
const logger = require('./lib/logger');

const PORT = 3000;

async function run() {
  const client = qbo.getOAuthClient();

  // AUTH-01: Complete OAuth flow
  const authUri = client.authorizeUri({
    scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.Payment],
    state: 'phase0-spike',
  });

  const app = express();

  const done = new Promise((resolve, reject) => {
    app.get('/callback', async (req, res) => {
      try {
        const authResponse = await client.createToken(req.url);
        const tokens = authResponse.getJson();

        // AUTH-02: Store tokens and realm context
        qbo.saveTokens(tokens);
        logger.result('AUTH-01', 'Pass', 'OAuth flow completed');
        logger.result('AUTH-02', 'Pass', 'Tokens and realm context stored');

        // AUTH-04: Verify request targets intended company
        const realmFromCallback = req.query.realmId;
        if (realmFromCallback === config.realmId) {
          logger.result('AUTH-04', 'Pass', `Realm ID matches: ${realmFromCallback}`);
        } else {
          logger.result('AUTH-04', 'Partial',
            `Callback realm ${realmFromCallback} differs from configured ${config.realmId}. Update .env if needed.`);
        }

        res.send('<h2>Connected! You can close this tab and return to the terminal.</h2>');

        // AUTH-03: Test token refresh
        try {
          const refreshResponse = await client.refresh();
          qbo.saveTokens(refreshResponse.getJson());
          logger.result('AUTH-03', 'Pass', 'Token refresh succeeded');
        } catch (refreshErr) {
          logger.result('AUTH-03', 'Fail', 'Token refresh failed', refreshErr.message);
        }

        // Validate connection with a simple API call
        try {
          const companyInfo = await qbo.query("SELECT * FROM CompanyInfo");
          const info = companyInfo.QueryResponse?.CompanyInfo?.[0];
          logger.info('company', {
            name: info?.CompanyName,
            country: info?.Country,
            fiscalYearStart: info?.FiscalYearStartMonth,
          });
          logger.result('AUTH-VALIDATE', 'Pass', `Connected to: ${info?.CompanyName}`);
        } catch (apiErr) {
          logger.result('AUTH-VALIDATE', 'Fail', 'Could not query company info', apiErr.message);
        }

        resolve();
      } catch (err) {
        logger.result('AUTH-01', 'Fail', 'OAuth callback failed', err.message);
        res.status(500).send('OAuth failed. Check terminal.');
        reject(err);
      }
    });
  });

  const server = app.listen(PORT, () => {
    logger.info('oauth', `Callback server listening on port ${PORT}`);
    logger.info('oauth', `Opening browser for authorization...`);
    // Open browser (Windows)
    exec(`start "" "${authUri}"`);
  });

  await done;
  server.close();
  logger.info('oauth', 'Done. Tokens saved to .tokens.json');
}

run().catch(err => {
  logger.error('fatal', err.message);
  process.exit(1);
});
