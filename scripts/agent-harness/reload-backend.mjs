#!/usr/bin/env node
// Reload the dev backend after a coherent batch of backend/src edits, without cutting off an
// accountant review. nodemon watches only backend/reload.trigger (backend/nodemon.json), so saving
// source files no longer restarts the server; this script waits until no accountant review is
// running (up to --max-wait minutes, default 15), then touches the trigger.
// Usage: node scripts/agent-harness/reload-backend.mjs [--max-wait 15] [--now]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const args = process.argv.slice(2);
const now = args.includes('--now');
const maxWait = Number(args[args.indexOf('--max-wait') + 1]) || 15;
const trigger = path.join(root, 'backend', 'reload.trigger');

async function reviewRunning() {
  require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const recent = new Date(Date.now() - 20 * 60000);
  return Boolean(await mongoose.connection.db.collection('businessagentusages').findOne({ outcome: 'running', startedAt: { $gte: recent } }, { projection: { _id: 1 } }));
}

const deadline = Date.now() + maxWait * 60000;
let waited = false;
try {
  while (!now && Date.now() < deadline && await reviewRunning()) {
    if (!waited) { console.log('An accountant review is running; waiting for it to finish before reloading.'); waited = true; }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
} catch (error) {
  console.log('Could not check for a running review (' + error.message + '); reloading anyway.');
} finally {
  try { await require('mongoose').disconnect(); } catch { /* not connected */ }
}
writeFileSync(trigger, new Date().toISOString() + '\n');
console.log((Date.now() >= deadline ? 'Waited ' + maxWait + ' minutes; ' : '') + 'Backend reload triggered (backend/reload.trigger).');
