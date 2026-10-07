'use strict';
// No writes unless --apply and a separately approved --plan-hash are both supplied.
const path = require('node:path');
const { createRequire } = require('node:module');
const backendRequire = createRequire(path.resolve(__dirname, '../../backend/package.json'));
const { MongoClient } = backendRequire('mongoose').mongo;
const { previewSetup, applySetup, validateTarget, setupDefinition } = require('../../backend/src/modules/business-storage-setup');
function args(argv) {
  const value = {}; const allowed = new Set(['environment', 'realm-id', 'connection-id', 'owner-id', 'plan-hash', 'profile']);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--apply') { if (value.apply) throw new Error('Duplicate apply option'); value.apply = true; continue; }
    if (!key.startsWith('--') || !allowed.has(key.slice(2)) || value[key.slice(2)] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Invalid setup arguments');
    value[key.slice(2)] = argv[++index];
  }
  if (Boolean(value.apply) !== Boolean(value['plan-hash'])) throw new Error('Use --apply together with --plan-hash only after explicit approval');
  setupDefinition(value.profile);
  return value;
}
async function main(argv = process.argv.slice(2)) {
  const options = args(argv);
  backendRequire('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const config = require('../../backend/src/config');
  const target = { environment: options.environment, realmId: options['realm-id'], connectionId: options['connection-id'], ownerId: options['owner-id'] };
  validateTarget(target, config.qbo.environment);
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 20000, retryWrites: true });
  try {
    await client.connect();
    const result = options.apply ? await applySetup(client.db(), client, target, config.qbo.environment, options['plan-hash'], options.profile) : await previewSetup(client.db(), target, config.qbo.environment, options.profile);
    console.log(JSON.stringify(result, null, 2));
  } finally { await client.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.setupError ? error.message : 'Business storage setup failed. Connection details are suppressed. If apply started, additive preparation may remain; inspect its preview and audit receipts before retrying.'); process.exitCode = 1; });
module.exports = { args, main };
