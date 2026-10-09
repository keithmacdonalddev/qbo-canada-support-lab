#!/usr/bin/env node
'use strict';

// Agent scenario evaluation: runs support-request scenarios through the real
// Reproduce engine, system prompt and model provider against a simulated
// QuickBooks company. It makes live model-provider calls (Codex CLI on the
// owner's subscription, or an Anthropic key) but never QuickBooks or MongoDB
// calls: guard.js replaces the real QBO client and blocks database connects.
//
// Usage: node scripts/agent-eval/run.js --scenario <id> [--scenario <id>] | --all
//        [--concurrency 3] [--json out.json] [--provider codex|anthropic]
//        [--model <codex model>] [--effort low|medium|high|xhigh] [--list] [--skip-preflight]

const guard = require('./guard');

guard.install();

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
// Non-secret provider settings the backend would read from .env. Nothing else
// from .env is loaded, so QBO, JWT, database and key values never enter this process.
const ENV_ALLOWLIST = ['AI_PROVIDER', 'CODEX_MODEL', 'CODEX_REASONING_EFFORT', 'CODEX_TIMEOUT_MS', 'CODEX_CLI_PATH',
  'AI_MODEL_FAST', 'AI_MODEL_DEEP', 'AI_MAX_TOKENS'];

function loadProviderSettings(file = path.join(ROOT, '.env')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const loaded = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || !ENV_ALLOWLIST.includes(m[1]) || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    loaded.push(m[1]);
  }
  return loaded;
}

function parseArgs(argv) {
  const args = { scenarios: [], all: false, concurrency: 3, json: null, provider: null, model: null, effort: null, list: false, skipPreflight: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--scenario') args.scenarios.push(value());
    else if (a === '--all') args.all = true;
    else if (a === '--concurrency') args.concurrency = Math.max(1, Math.min(8, Number(value()) || 1));
    else if (a === '--json') args.json = value();
    else if (a === '--provider') args.provider = value();
    else if (a === '--model') args.model = value();
    else if (a === '--effort') args.effort = value();
    else if (a === '--list') args.list = true;
    else if (a === '--skip-preflight') args.skipPreflight = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.provider && !['codex', 'anthropic'].includes(args.provider)) throw new Error('--provider must be codex or anthropic');
  return args;
}

// Codex reaches the case tools over HTTP MCP at http://127.0.0.1:${config.port}.
// The owner's backend owns the configured port, so serve the bridge from our
// own short-lived server on a free port instead.
function startBridgeServer(handleMcpRequest) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      if (!String(req.url || '').startsWith('/api/ai-tools/mcp')) { res.statusCode = 404; res.end(); return; }
      if (req.method === 'GET') { res.statusCode = 405; res.setHeader('Allow', 'POST'); res.end(); return; }
      if (req.method === 'DELETE') { res.statusCode = 200; res.end(); return; }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(String(req.headers.authorization || '').trim());
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { res.statusCode = 400; res.end(); return; }
      try {
        const { status, json } = await handleMcpRequest(match ? match[1].toLowerCase() : '', parsed);
        res.statusCode = status;
        if (json === null) { res.end(); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(json));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err?.message || err).slice(0, 200) }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

const pad = (value, width) => {
  const text = String(value ?? '');
  return text.length > width ? text.slice(0, width - 1) + '…' : text.padEnd(width);
};

function summarize(scenario, ctx, grade, error) {
  return {
    id: scenario.id,
    title: scenario.title,
    request: scenario.turns || scenario.request,
    pass: !!grade?.pass,
    firstFailure: error ? 'harness error: ' + error : grade?.firstFailure || null,
    notes: grade?.notes || [],
    outcome: ctx?.state?.outcome || null,
    status: ctx?.state?.status || null,
    summary: ctx?.state?.summary || null,
    awaitingOperator: ctx?.state?.awaitingOperator ?? null,
    limitations: ctx?.state?.limitations || [],
    conditions: ctx?.state?.conditions || [],
    checks: ctx?.state?.checks || [],
    agentReplies: ctx?.state?.agentReplies ?? null,
    engineToolTrace: ctx?.state?.toolTrace ?? null,
    toolCalls: ctx?.trace?.length || 0,
    writes: ctx ? ctx.company.mutations().length : 0,
    turns: (ctx?.turns || []).map((t) => ({ index: t.index, message: t.message, skipped: !!t.skipped, reason: t.reason, outcome: t.state?.outcome,
      status: t.state?.status, summary: t.state?.summary, writes: t.writes, passes: t.passes, ms: t.ms, engineError: t.engineError })),
    trace: ctx?.trace || [],
    planSteps: ctx?.plan?.steps || [],
    callLog: ctx?.calls || [],
    createdRecords: ctx ? ctx.company.snapshotCreated() : {},
    ms: ctx?.ms ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Provider settings must be in place before any backend module loads config.
  const loaded = loadProviderSettings();
  if (args.provider) process.env.AI_PROVIDER = args.provider;
  if (args.model) process.env.CODEX_MODEL = args.model;
  if (args.effort) process.env.CODEX_REASONING_EFFORT = args.effort;
  const { scenarios, gradeScenario } = require('./scenarios');
  if (args.help || args.list) {
    if (args.help) console.log('Usage: node scripts/agent-eval/run.js --scenario <id> | --all [--concurrency N] [--json file] [--provider codex|anthropic] [--model m] [--effort e] [--skip-preflight]');
    for (const s of scenarios) console.log(pad(s.id, 36) + ' ' + s.title);
    return 0;
  }
  const selected = args.all ? scenarios : scenarios.filter((s) => args.scenarios.includes(s.id));
  const unknown = args.scenarios.filter((id) => !scenarios.some((s) => s.id === id));
  if (unknown.length) throw new Error('Unknown scenario(s): ' + unknown.join(', ') + '. Use --list.');
  if (!selected.length) throw new Error('Choose --scenario <id> (repeatable) or --all. Use --list to see scenarios.');

  const config = require(path.join(guard.BACKEND_SRC, 'config'));
  // Belt and braces: the simulated company is the only QuickBooks target.
  config.qbo.clientId = ''; config.qbo.clientSecret = ''; config.mongoUri = 'mongodb://eval-blocked.invalid:1/none';

  const { handleMcpRequest } = require(path.join(guard.BACKEND_SRC, 'modules', 'ai-tool-bridge'));
  const server = await startBridgeServer(handleMcpRequest);
  config.port = server.address().port; // must be set before any createToolSession

  const aiProvider = require(path.join(guard.BACKEND_SRC, 'modules', 'ai-provider'));
  const codexCli = require(path.join(guard.BACKEND_SRC, 'modules', 'codex-cli'));
  const { createRunner } = require(path.join(guard.BACKEND_SRC, 'modules', 'reproduction-runner'));
  const refuse = () => { throw new Error('Agent eval refused: database and QuickBooks models are unavailable.'); };
  const runner = createRunner({
    AISession: {}, AIPlan: {}, Connection: {}, CompanyMembership: {}, User: {}, config,
    createQBOClient: async () => refuse(), createAuditEntry: async () => refuse(),
  });
  const { runScenario } = require('./harness');

  const provider = await aiProvider.resolveProvider();
  const apiKey = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY || null : null;
  if (provider === 'anthropic' && !apiKey) throw new Error('The anthropic provider needs ANTHROPIC_API_KEY in the environment (it is not read from .env).');
  const meta = {
    startedAt: new Date().toISOString(), provider, codexModel: provider === 'codex' ? config.ai.codex.model : null,
    codexEffort: provider === 'codex' ? config.ai.codex.effort : null, anthropicModel: provider === 'anthropic' ? config.ai.modelFast : null,
    codexVersion: provider === 'codex' && typeof codexCli.getCodexVersion === 'function' ? await codexCli.getCodexVersion() : null,
    settingsFromEnvFile: loaded, bridgePort: config.port, concurrency: args.concurrency, scenarios: selected.map((s) => s.id),
  };
  console.log(`Provider: ${provider}${meta.codexModel ? ` (${meta.codexModel}, effort ${meta.codexEffort}${meta.codexVersion ? ', Codex ' + meta.codexVersion : ''})` : meta.anthropicModel ? ` (${meta.anthropicModel})` : ''}. Simulated company only; no QuickBooks or MongoDB access.`);

  if (provider === 'codex' && !args.skipPreflight && typeof codexCli.verifyToolAccess === 'function') {
    meta.toolAccess = await codexCli.verifyToolAccess({ refresh: false });
    if (!meta.toolAccess?.ok) {
      console.error('Codex tool access check failed: ' + (meta.toolAccess?.reason || 'unknown reason'));
      server.close();
      return 2;
    }
  }

  const runModel = ({ transcript, system, execute, tools, budget }) => runner.runProvider(transcript, system, execute, tools, apiKey, budget);
  const results = await pool(selected, args.concurrency, async (scenario) => {
    const started = Date.now();
    let ctx = null; let grade = null; let error = null;
    try {
      ctx = await runScenario({ scenario, runModel });
      grade = gradeScenario(scenario, ctx);
    } catch (err) {
      error = String(err?.stack || err).split('\n').slice(0, 3).join(' | ');
    }
    const row = summarize(scenario, ctx, grade, error);
    console.log(`${row.pass ? 'PASS' : 'FAIL'} ${scenario.id} (${Math.round((Date.now() - started) / 1000)}s)`);
    return row;
  });
  server.close();

  console.log('');
  console.log([pad('scenario', 34), pad('outcome', 14), pad('calls', 6), pad('writes', 7), pad('result', 7), 'first failing note'].join(' '));
  for (const r of results) {
    console.log([pad(r.id, 34), pad(r.outcome, 14), pad(r.toolCalls, 6), pad(r.writes, 7), pad(r.pass ? 'pass' : 'FAIL', 7), r.firstFailure || ''].join(' '));
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed.`);

  const report = { meta: { ...meta, finishedAt: new Date().toISOString(), guardViolations: guard.violations }, results };
  const outDir = path.join(ROOT, 'artifacts', 'agent-eval');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('Full report: ' + path.relative(ROOT, file));
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2));
    console.log('Also written to: ' + path.resolve(args.json));
  }
  if (guard.violations.length) { console.error('Guard violations: ' + JSON.stringify(guard.violations)); return 2; }
  return passed === results.length ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(String(err?.message || err));
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, loadProviderSettings, startBridgeServer, ENV_ALLOWLIST };
