'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let checks=0;function check(value,msg){assert.ok(value,msg);checks++;}
const roles=['harness-worker','harness-reviewer','harness-security-reviewer'];
for(const role of roles){
 const codex=read('.codex/agents/'+role+'.toml'),claude=read('.claude/agents/'+role+'.md');
 check(codex.includes('name = "'+role+'"')&&codex.includes('developer_instructions ='),'Codex role '+role);
 check(claude.includes('name: '+role)&&claude.includes('model: inherit'),'Claude role '+role);
 if(role!=='harness-worker'){
  check(codex.includes('sandbox_mode = "read-only"'),'Codex reviewer sandbox');
  check(claude.includes('tools: Read, Glob, Grep')&&!/tools:.*(?:Bash|PowerShell|Write|Edit)/.test(claude),'Claude reviewer tool restrictions');
 }
 check(!/^model(?:_reasoning_effort)?\s*=/m.test(codex),'No pinned Codex model');
}
const cx=JSON.parse(read('.codex/hooks.json')),cl=JSON.parse(read('.claude/settings.json'));
for(const event of ['SessionStart','UserPromptSubmit','PreToolUse']){
 check(cx.hooks[event]?.some(g=>g.hooks.some(h=>h.command?.includes('workflow.cjs'))),'Codex event '+event);
 check(cl.hooks[event]?.some(g=>g.hooks.some(h=>h.command==='node'&&h.args?.some(a=>a.includes('workflow.cjs')))),'Claude event '+event);
}
check(read('AGENT_WORKFLOW.md').includes('Commit and push only when explicitly requested'),'Git policy');
check(read('CLAUDE.md').includes('@AGENT_WORKFLOW.md'),'Claude import');
check(read('AGENTS.md').includes('AGENT_WORKFLOW.md'),'Codex route');
check(read('AGENTS.md').includes('ACCEPTANCE_AND_REVIEW.md'),'Outcome and review route');
check(read('AGENTS.md').includes('gpt-6-luna'),'Luna-only root rule');
check(read('docs/agent-harness/DETERMINISTIC_TEST_EXECUTION.md').includes('luna-exec.mjs'),'Luna bridge route');
check(fs.existsSync(path.join(root,'scripts/agent-harness/luna-exec.mjs')),'Luna bridge present');
const policy=JSON.parse(read('scripts/agent-harness/project-policy.json'));
check(typeof policy.safety_focus==='string'&&policy.safety_focus.length>30,'Project safety focus');
const helper=require('./workflow.cjs');
check(helper.promptText(root).includes('Commit and push only when explicitly requested'),'Live prompt output');
check(helper.promptText(root).includes('independent implementation and safety review'),'Live review reminder');
check(!helper.sessionStart(root).hookSpecificOutput.additionalContext.includes('files missing'),'Essential files');
console.log(JSON.stringify({ok:true,checks,project:policy.project,scope:'static wiring plus direct helper output; not client activation'}));
