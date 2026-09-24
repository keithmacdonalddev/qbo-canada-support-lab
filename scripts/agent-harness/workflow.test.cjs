'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commandDecision, preToolUse, sensitiveFile, shellSegments } = require('./workflow.cjs');

const blocked = [
  'git reset --hard', 'git -C "C:/Projects/example" reset --hard HEAD',
  'git clean -fd', 'git clean -xdf', 'git push --force-with-lease origin main',
  'git push origin +HEAD:main', 'git branch -D old-work', 'git add .', 'git add -A',
  'Get-Content -LiteralPath "C:/demo/.env"', 'cat .env.production', 'type .tokens.json',
  'rg "TOKEN" .env', 'git show HEAD:.env',
  'git status; git reset --hard', 'powershell -NoProfile -Command "git reset --hard"',
  'bash -c "git clean -fd"', 'Remove-Item -LiteralPath . -Recurse -Force',
  'rm -rf ..', 'rm -rf /',
];
for (const command of blocked) test('blocks: ' + command, () => assert.ok(commandDecision(command).block));
const allowed = [
  'git status --short --branch', 'git diff --check', 'git clean -nd', 'git clean -nfd',
  'git add -- AGENT_WORKFLOW.md', 'node --test test/example.test.js', 'npm test',
  'Get-Content .env.example', 'cat .env.sample', 'rg --files -g .env',
  'rg "git reset --hard" AGENTS.md', 'echo "git clean -fd"',
  'rg ".env" docs', 'Get-Content README.md',
];
for (const command of allowed) test('allows: ' + command, () => assert.equal(commandDecision(command).block, undefined));
for (const command of ['npm run dev', 'Stop-Process -Id 1234', 'git commit -m docs', 'git push origin main', 'npm run db:prepare']) {
  test('reminds without overriding prior authorization: ' + command, () => {
    const result=preToolUse({tool_name:'Bash',tool_input:{command}});
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
    assert.match(result.hookSpecificOutput.additionalContext,/authoriz|requested/);
  });
}
test('read tool protects secret path',()=>assert.equal(preToolUse({tool_name:'Read',tool_input:{file_path:'C:/a/.env'}}).hookSpecificOutput.permissionDecision,'deny'));
test('read tool allows example',()=>assert.equal(preToolUse({tool_name:'Read',tool_input:{file_path:'.env.example'}}),null));
test('unknown non-shell tool does not acquire permission',()=>assert.equal(preToolUse({tool_name:'mcp__service__query',tool_input:{}}),null));
test('malformed shell input is blocked',()=>assert.equal(preToolUse({tool_name:'Bash',tool_input:{}}).hookSpecificOutput.permissionDecision,'deny'));
test('malformed tool input is blocked',()=>assert.equal(preToolUse(null).hookSpecificOutput.permissionDecision,'deny'));
test('Codex exec alias is covered',()=>assert.equal(preToolUse({tool_name:'exec_command',tool_input:{cmd:'git reset --hard'}}).hookSpecificOutput.permissionDecision,'deny'));
test('quoted separators remain data',()=>assert.deepEqual(shellSegments('rg "git reset --hard; git clean -fd" docs'),[['rg','git reset --hard; git clean -fd','docs']]));
test('secret reasons never echo values',()=>assert.doesNotMatch(JSON.stringify(preToolUse({tool_name:'Bash',tool_input:{command:'cat .env # PRIVATE_SAMPLE_VALUE'}})),/PRIVATE_SAMPLE_VALUE/));
test('secret examples are explicitly allowed',()=>{assert.equal(sensitiveFile('.env.example'),false);assert.equal(sensitiveFile('.env.production'),true)});
test('startup preview needs no service reminder',()=>assert.deepEqual(commandDecision('npm run dev:preview'),{}));
test('read-only startup check needs no service reminder',()=>assert.deepEqual(commandDecision('npm run dev:check'),{}));
test('project server entrypoint is recognized',()=>assert.match(commandDecision('node backend/src/server.js',process.cwd(),0,{runtime_entrypoints:['backend/src/server.js']}).warning,/Service\/data/));
test('project company operation is recognized without inventing permission',()=>{const r=commandDecision('curl -X POST http://localhost/api/seed',process.cwd(),0,{external_operation_routes:['/api/seed']});assert.match(r.warning,/environment\/company/);assert.equal(r.block,undefined)});
