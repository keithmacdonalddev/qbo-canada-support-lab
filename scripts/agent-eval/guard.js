'use strict';

// Makes it impossible for the agent eval to reach the real QuickBooks company
// or MongoDB. Install before any backend module is required: the real
// qbo-client is replaced in the require cache by a stub that throws, and
// mongoose refuses to connect or buffer commands.

const path = require('path');
const Module = require('module');

const BACKEND_SRC = path.resolve(__dirname, '../../backend/src');
const QBO_CLIENT = path.join(BACKEND_SRC, 'modules', 'qbo-client.js');
const DATABASE = path.join(BACKEND_SRC, 'config', 'database.js');
const violations = [];
let installed = false;

function refuse(what) {
  violations.push({ what, at: new Date().toISOString() });
  throw new Error(`Agent eval refused: ${what}. The evaluation uses only the simulated company.`);
}

function stubModule(file, exports) {
  const stub = new Module(file, module);
  stub.filename = file;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[file] = stub;
}

function install() {
  if (installed) return;
  for (const file of [QBO_CLIENT, DATABASE]) {
    const cached = require.cache[file];
    if (cached && !cached.exports?.__agentEvalStub) {
      throw new Error(`Agent eval refused to start: ${path.basename(file)} was loaded before the guard.`);
    }
  }
  class QBOClient { constructor() { refuse('constructing the real QuickBooks client'); } }
  stubModule(QBO_CLIENT, { __agentEvalStub: true, QBOClient, createQBOClient: async () => refuse('creating the real QuickBooks client') });
  stubModule(DATABASE, Object.assign(async () => refuse('connecting to MongoDB'), { __agentEvalStub: true, connectDB: async () => refuse('connecting to MongoDB') }));

  const mongoose = require(require.resolve('mongoose', { paths: [BACKEND_SRC] }));
  mongoose.set('bufferCommands', false);
  mongoose.connect = async () => refuse('connecting to MongoDB');
  mongoose.createConnection = () => refuse('connecting to MongoDB');
  mongoose.Connection.prototype.openUri = async () => refuse('connecting to MongoDB');
  installed = true;
}

module.exports = { install, violations, BACKEND_SRC, QBO_CLIENT };
