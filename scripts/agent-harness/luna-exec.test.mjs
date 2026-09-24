import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assessEvidence,
  readRequestFile,
  REQUIRED_EFFORT,
  REQUIRED_MODEL,
  resolveExistingProjectPath,
  resolveRequestPath,
  resolveReceiptPath,
  runLunaRequest,
  validateRequest,
  writeReceiptAtomic,
} from './luna-exec.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qbo-luna-exec-'));
  t.after(() => {
    assert.equal(dirname(root), tmpdir());
    rmSync(root, { recursive: true, force: true });
  });
  const sessionsRoot = join(root, 'sessions');
  mkdirSync(sessionsRoot);
  mkdirSync(join(root, 'artifacts', 'luna'), { recursive: true });
  const fakeCli = join(root, 'fake-codex.mjs');
  writeFileSync(fakeCli, `
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
if(process.env.FAKE_ARGS_PATH)writeFileSync(process.env.FAKE_ARGS_PATH,JSON.stringify(process.argv.slice(2)));
if(process.env.FAKE_PROMPT_PATH)writeFileSync(process.env.FAKE_PROMPT_PATH,Buffer.concat(chunks).toString('utf8'));
const id=process.env.FAKE_THREAD_ID;
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:id})+'\\n');
if(process.env.FAKE_STDERR)process.stderr.write(process.env.FAKE_STDERR);
if(process.env.FAKE_MODE==='hang'){setInterval(()=>{},1000);}
else{
 const rows=[];
 if(process.env.FAKE_SESSION!=='missing')rows.push({timestamp:new Date().toISOString(),type:'session_meta',payload:{id,session_id:id,cwd:process.env.FAKE_CWD,originator:'codex_exec',source:'exec',model_provider:'openai',base_instructions:{provenance:{model:process.env.FAKE_MODEL}}}});
 if(process.env.FAKE_TURN!=='missing')rows.push({timestamp:new Date().toISOString(),type:'turn_context',payload:{turn_id:'turn-1',cwd:process.env.FAKE_CWD,model:process.env.FAKE_MODEL,effort:process.env.FAKE_EFFORT,collaboration_mode:{settings:{model:process.env.FAKE_MODEL,reasoning_effort:process.env.FAKE_EFFORT}}}});
 const commands=JSON.parse(process.env.FAKE_COMMANDS||'[]');
 const timing=JSON.parse(process.env.FAKE_TIMING||'null')||commands.map((_,index)=>({start:index*2,end:index*2+1}));
 const order=timing.map((_,index)=>index).sort((l,r)=>timing[l].end-timing[r].end);
 const base=Date.parse('2026-09-21T10:00:00Z');
 for(const index of order)rows.push({timestamp:new Date(base+timing[index].end*1000).toISOString(),type:'event_msg',payload:{type:'item_completed',thread_id:id,turn_id:'turn-1',item:{type:'CommandExecution',id:'exec-'+index,command:['pwsh.exe','-Command',commands[index]],cwd:pathToFileURL(process.env.FAKE_CWD).href,status:process.env.FAKE_STATUS||'completed',stdout:'ok '+index,exit_code:index===Number(process.env.FAKE_FAIL_INDEX)?1:0,...(process.env.FAKE_NO_DURATION?{}:{duration:{secs:timing[index].end-timing[index].start,nanos:0}})}}});
 if(process.env.FAKE_EXTRA_ITEM_TYPE)rows.push({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'item_completed',thread_id:id,turn_id:'turn-1',item:{type:process.env.FAKE_EXTRA_ITEM_TYPE,id:'extra-action'}}});
 const dir=join(process.env.FAKE_SESSIONS_ROOT,'2026','09','21');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'rollout-'+id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n');
 if(process.env.FAKE_DESCENDANT_PATH){const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});descendant.unref();writeFileSync(process.env.FAKE_DESCENDANT_PATH,String(descendant.pid));await new Promise(resolve=>setTimeout(resolve,750));}
 process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'runner summary'}})+'\\n');
 process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}})+'\\n');
 process.exitCode=Number(process.env.FAKE_EXIT||0);
}
`);
  return { root, sessionsRoot, fakeCli };
}

function request(root, commands = ['node --test scripts/agent-harness/focused.test.mjs']) {
  return {
    version: 1,
    cwd: root,
    commands,
    boundaries: ['Do not edit application code or install dependencies.'],
    affectedPaths: ['scripts/agent-harness/focused.test.mjs'],
    expectedArtifacts: [],
    timeoutMs: 10_000,
  };
}

function options(f, overrides = {}) {
  const commands = overrides.commands || ['node --test scripts/agent-harness/focused.test.mjs'];
  return {
    root: f.root,
    executable: process.execPath,
    prefixArgs: [f.fakeCli],
    sessionsRoot: f.sessionsRoot,
    processSnapshot: async () => [],
    env: {
      ...process.env,
      FAKE_THREAD_ID: overrides.threadId || '11111111-1111-7111-8111-111111111111',
      FAKE_SESSIONS_ROOT: f.sessionsRoot,
      FAKE_CWD: f.root,
      FAKE_MODEL: overrides.model || REQUIRED_MODEL,
      FAKE_EFFORT: overrides.effort || REQUIRED_EFFORT,
      FAKE_COMMANDS: JSON.stringify(commands),
      ...(overrides.env || {}),
    },
    ...(overrides.options || {}),
  };
}

test('validates bounded in-project requests and rejects path or command injection shapes', t => {
  const f = fixture(t);
  assert.deepEqual(validateRequest(request(f.root), { root: f.root }).commands, ['node --test scripts/agent-harness/focused.test.mjs']);
  assert.throws(() => validateRequest({ ...request(f.root), cwd: resolve(f.root, '..') }, { root: f.root }), /escapes the project root/);
  assert.throws(() => validateRequest({ ...request(f.root), commands: ['node --test ok\nwhoami'] }, { root: f.root }), /single-line/);
  for (const unsafe of ['npm run seed', 'npm run dev', 'node backend/src/server.js', 'node --test scripts/phase-0/02-seed-master-data.js', 'node --test ../scripts/agent-harness/focused.test.mjs', 'node --test scripts/agent-harness/focused.test.mjs; npm run seed']) {
    assert.throws(() => validateRequest(request(f.root, [unsafe]), { root: f.root }), /outside the bridge's non-live check list/);
  }
  assert.deepEqual(
    validateRequest(request(f.root, ['npm run test --workspace=backend', 'node scripts/agent-harness/check-backend-syntax.mjs', 'git diff --check']), { root: f.root }).commands,
    ['npm run test --workspace=backend', 'node scripts/agent-harness/check-backend-syntax.mjs', 'git diff --check'],
  );
  assert.throws(() => resolveReceiptPath(resolve(f.root, '..', 'receipt.json'), { root: f.root }), /directly under artifacts\/luna/);
  assert.throws(() => resolveReceiptPath(join(f.root, 'AGENTS.md'), { root: f.root }), /directly under artifacts\/luna/);
  assert.throws(() => resolveRequestPath(join(f.root, 'AGENTS.md'), { root: f.root }), /directly under artifacts\/luna/);
  const requestPath = join(f.root, 'artifacts', 'luna', 'request.json');
  writeFileSync(requestPath, '{}');
  assert.equal(resolveRequestPath(requestPath, { root: f.root }), requestPath);
  const outside = mkdtempSync(join(tmpdir(), 'qbo-luna-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const link = join(f.root, 'outside-link');
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveExistingProjectPath(link, { root: f.root, type: 'directory' }), /Symbolic-link/);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  const oversized = join(f.root, 'oversized.json');
  writeFileSync(oversized, 'x'.repeat(65));
  assert.throws(() => readRequestFile(oversized, { maxBytes: 64 }), /input limit/);
});

test('launches with fixed Luna argv plus stdin and accepts exact transcript evidence', async t => {
  const f = fixture(t);
  const argsPath = join(f.root, 'args.json');
  const promptPath = join(f.root, 'prompt.txt');
  const command = 'node --test scripts/agent-harness/focused.test.mjs';
  const runOptions = options(f, { commands: [command], env: { FAKE_ARGS_PATH: argsPath, FAKE_PROMPT_PATH: promptPath } });
  const receipt = await runLunaRequest(request(f.root, [command]), runOptions);
  assert.equal(receipt.status, 'passed', JSON.stringify(receipt, null, 2));
  assert.equal(receipt.runner.identityVerified, true);
  assert.equal(receipt.commands[0].observed.exitCode, 0);
  assert.equal(receipt.commands[0].exactCommand, true);
  assert.equal(receipt.commands[0].exactCwd, true);
  assert.equal(receipt.cleanup.verified, true);
  const args = JSON.parse(readFileSync(argsPath, 'utf8'));
  assert.deepEqual(args.slice(-3), ['-c', 'model_reasoning_effort="low"', '-']);
  assert.equal(args.includes(REQUIRED_MODEL), true);
  const prompt = readFileSync(promptPath, 'utf8');
  assert.match(prompt, /Run each commands entry exactly once, separately, in order/);
  assert.match(prompt, /Never launch commands concurrently/);
  assert.match(prompt, /If project instructions require file reads first/);
  assert.match(prompt, /at most 3 guidance-read command invocations/);
  assert.match(prompt, /node --test scripts\/agent-harness\/focused\.test\.mjs/);
});

test('accepts bounded project-guidance reads before the exact requested command', async t => {
  const f = fixture(t);
  const guidance = 'Get-Content AGENT_WORKFLOW.md; Get-Content docs/agent-harness/PROJECT_PROFILE.md; Get-Content docs/agent-harness/DETERMINISTIC_TEST_EXECUTION.md';
  const requested = 'node scripts/agent-harness/verify.cjs';
  const receipt = await runLunaRequest(request(f.root, [requested]), options(f, {
    commands: [guidance, requested],
    threadId: '33333333-3333-7333-8333-333333333334',
  }));
  assert.equal(receipt.status, 'passed', JSON.stringify(receipt, null, 2));
  assert.equal(receipt.guidanceReads.length, 1);
  assert.equal(receipt.guidanceReads[0].command, guidance);
  assert.equal(receipt.commands.length, 1);
  assert.equal(receipt.commands[0].observed.command, requested);
  assert.equal(receipt.commands[0].observed.exitCode, 0);
  assert.deepEqual(receipt.evidenceProblems, []);
});

test('rejects unrelated, late, and failed guidance reads', async t => {
  const f = fixture(t);
  const requested = 'node scripts/agent-harness/verify.cjs';
  const guidance = 'Get-Content AGENT_WORKFLOW.md';
  const cases = [
    { commands: ['Get-Content .env', requested] },
    { commands: [requested, guidance] },
    { commands: [guidance, requested], env: { FAKE_FAIL_INDEX: '0' } },
    { commands: [guidance, requested], env: { FAKE_NO_DURATION: '1' }, problem: 'command-order-unverified' },
    { commands: [requested, guidance], env: { FAKE_TIMING: JSON.stringify([{ start: 0, end: 30 }, { start: 1, end: 2 }]), FAKE_NO_DURATION: '1' }, problem: 'command-order-unverified' },
    { commands: [guidance, guidance, guidance, guidance, requested] },
  ];
  for (const [index, testCase] of cases.entries()) {
    const receipt = await runLunaRequest(request(f.root, [requested]), options(f, {
      commands: testCase.commands,
      threadId: `33333333-3333-7333-8333-33333333333${index + 5}`,
      env: testCase.env,
    }));
    assert.equal(receipt.status, testCase.problem ? 'blocked' : 'failed', JSON.stringify(receipt, null, 2));
    assert.equal(receipt.reason, testCase.problem || 'command-evidence-failed');
    if (testCase.problem) assert.ok(receipt.evidenceProblems.includes(testCase.problem), JSON.stringify(receipt.evidenceProblems));
  }
});

test('fails closed for wrong or missing runtime metadata', async t => {
  const f = fixture(t);
  const wrong = await runLunaRequest(request(f.root), options(f, { model: 'glm-5.3-flash', threadId: '22222222-2222-7222-8222-222222222222' }));
  assert.equal(wrong.status, 'blocked');
  assert.equal(wrong.reason, 'runner-identity-unverified');
  const missing = await runLunaRequest(request(f.root), options(f, { threadId: '33333333-3333-7333-8333-333333333333', env: { FAKE_TURN: 'missing' } }));
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reason, 'transcript-evidence-unavailable');
});

test('rejects combined, extra, missing, and failing command executions', async t => {
  const f = fixture(t);
  const requested = ['node --test scripts/agent-harness/one.test.mjs', 'node --test scripts/agent-harness/two.test.mjs'];
  const cases = [
    ['combined', ['node --test scripts/agent-harness/one.test.mjs; node --test scripts/agent-harness/two.test.mjs'], {}],
    ['extra', [...requested, 'git status --short'], {}],
    ['missing', [requested[0]], {}],
    ['failed', requested, { FAKE_FAIL_INDEX: '1' }],
    ['missing-timing', requested, { FAKE_NO_DURATION: '1' }],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [name, observed, env] = cases[index];
    const receipt = await runLunaRequest(request(f.root, requested), options(f, {
      commands: observed,
      threadId: `44444444-4444-7444-8444-44444444444${index}`,
      env,
    }));
    assert.equal(receipt.status, name === 'missing-timing' ? 'blocked' : 'failed', `${name}: ${JSON.stringify(receipt, null, 2)}`);
    assert.equal(receipt.reason, name === 'missing-timing' ? 'command-order-unverified' : 'command-evidence-failed');
  }
});

test('orders evidence by start time and rejects commands that ran at the same time', async t => {
  const f = fixture(t);
  const requested = ['node --test scripts/agent-harness/one.test.mjs', 'node --test scripts/agent-harness/two.test.mjs'];
  // Sequential, but the transcript lists the second command first: accepted, matched in start order.
  const sequential = await runLunaRequest(request(f.root, requested), options(f, {
    commands: requested,
    threadId: '55555555-5555-7555-8555-555555555550',
    env: { FAKE_TIMING: JSON.stringify([{ start: 0, end: 10 }, { start: 10, end: 12 }]) },
  }));
  assert.equal(sequential.status, 'passed', JSON.stringify(sequential, null, 2));
  // Both launched at once; the second finished first. Rejected as parallel, not as a command mismatch.
  const parallel = await runLunaRequest(request(f.root, requested), options(f, {
    commands: requested,
    threadId: '55555555-5555-7555-8555-555555555551',
    env: { FAKE_TIMING: JSON.stringify([{ start: 0, end: 30 }, { start: 1, end: 15 }]) },
  }));
  assert.equal(parallel.status, 'failed');
  assert.ok(parallel.evidenceProblems.includes('commands-ran-in-parallel'), JSON.stringify(parallel.evidenceProblems));
  assert.ok(!parallel.evidenceProblems.some(problem => problem.startsWith('command-mismatch')), JSON.stringify(parallel.evidenceProblems));
});

test('rejects an unrequested completed file or tool action', async t => {
  const f = fixture(t);
  for (const [index, type] of ['FileChange', 'UnknownToolAction'].entries()) {
    const receipt = await runLunaRequest(request(f.root), options(f, {
      threadId: `55555555-5555-7555-8555-55555555555${index}`,
      env: { FAKE_EXTRA_ITEM_TYPE: type },
    }));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.reason, 'command-evidence-failed');
    assert.deepEqual(receipt.unrequestedActions.map(action => action.type), [type]);
    assert.equal(receipt.evidenceProblems.includes(`unrequested-action:${type}`), true);
  }
});

test('distinguishes runner process failure from command evidence', async t => {
  const f = fixture(t);
  const receipt = await runLunaRequest(request(f.root), options(f, { env: { FAKE_EXIT: '7' } }));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.reason, 'runner-process-failed');
  assert.equal(receipt.process.exitCode, 7);
});

test('reports a project hook permission denial as blocked', async t => {
  const f = fixture(t);
  const receipt = await runLunaRequest(request(f.root), options(f, {
    commands: [],
    env: { FAKE_STDERR: 'Command blocked by PreToolUse hook: checkpoint required.' },
  }));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'runner-command-blocked');
});

test('times out, terminates the exact task-owned process tree, and fails', async t => {
  const f = fixture(t);
  const receipt = await runLunaRequest(request(f.root), options(f, {
    env: { FAKE_MODE: 'hang' },
    options: { timeoutMsOverride: 150, transcriptWaitMs: 50 },
  }));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.process.termination, 'timeout');
  assert.equal(receipt.cleanup.attempted, true);
  assert.equal(receipt.cleanup.verified, true, JSON.stringify(receipt.cleanup));
});

test('an interrupt terminates the exact task-owned process tree and fails closed', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const receipt = await runLunaRequest(request(f.root), options(f, {
    env: { FAKE_MODE: 'hang' },
    options: { signal: controller.signal, transcriptWaitMs: 50 },
  }));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.process.termination, 'interrupted');
  assert.equal(receipt.cleanup.attempted, true);
  assert.equal(receipt.cleanup.verified, true, JSON.stringify(receipt.cleanup));
});

test('detects, terminates, and rechecks a surviving real descendant on Windows', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const descendantPath = join(f.root, 'descendant.pid');
  const receipt = await runLunaRequest(request(f.root), options(f, {
    env: { FAKE_DESCENDANT_PATH: descendantPath },
    options: { processSnapshot: undefined },
  }));
  assert.equal(Number.isInteger(Number(readFileSync(descendantPath, 'utf8'))), true);
  assert.equal(receipt.cleanup.descendants.attempted, true, JSON.stringify(receipt.cleanup));
  assert.equal(receipt.cleanup.descendants.survivorsBefore.length, 1, JSON.stringify(receipt.cleanup));
  assert.deepEqual(receipt.cleanup.descendants.survivorsAfter, []);
  assert.equal(receipt.cleanup.verified, true);
  assert.equal(receipt.status, 'passed', JSON.stringify(receipt, null, 2));
});

test('bounds transcript evidence and writes receipts atomically', async t => {
  const f = fixture(t);
  const receipt = await runLunaRequest(request(f.root), options(f, { options: { maxTranscriptBytes: 32 } }));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'transcript-evidence-unavailable');
  const target = resolveReceiptPath(join(f.root, 'artifacts', 'luna', 'receipt.json'), { root: f.root });
  writeReceiptAtomic(target, receipt);
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).status, 'blocked');
  assert.equal(readFileSync(target, 'utf8').endsWith('\n'), true);
  assert.throws(() => resolveReceiptPath(target, { root: f.root }), /already exists/);
  assert.equal(readFileSync(target, 'utf8').includes('runner summary'), false);
  assert.equal(readFileSync(target, 'utf8').includes('ok 0'), false);
});

test('assessEvidence treats any uncertainty as a failure', t => {
  const f = fixture(t);
  const req = validateRequest(request(f.root), { root: f.root });
  const transcript = {
    session: { id: 'thread', originator: 'codex_exec', source: 'exec', provenanceModel: REQUIRED_MODEL, cwd: f.root },
    turn: { id: 'turn', model: REQUIRED_MODEL, effort: REQUIRED_EFFORT, cwd: f.root, collaborationModel: REQUIRED_MODEL, collaborationEffort: REQUIRED_EFFORT },
    executions: [],
  };
  const result = assessEvidence(req, 'thread', transcript);
  assert.deepEqual(result.problems, ['unexpected-command-count', 'missing-command:0']);
});
