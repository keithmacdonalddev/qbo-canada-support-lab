#!/usr/bin/env node
const RULES=[
  [/\bgit\s+reset\s+--hard\b/i,'Workspace protection: git reset --hard can erase concurrent or uncommitted work.'],
  [/\bgit\s+clean\s+(?:-[^\s]*f|--force)\b/i,'Workspace protection: git clean can permanently delete untracked work.'],
  [/\bgit\s+push\b[^\r\n;&|]*(?:--force(?:-with-lease)?|-f)\b/i,'Workspace protection: automated force-pushes are not allowed.'],
  [/\bgit\s+branch\s+-D\b/i,'Workspace protection: automated force-deletion of branches is not allowed.'],
  [/(?:\b(?:cat|type|more)\b|\bget-content\b)[^\r\n;&|]*(?:[\\/\s]|^)(?:\.env(?:\.[\w.-]+)?|\.tokens\.json|id_rsa|id_ed25519)\b/i,'Secret protection: do not print an entire environment, token, or private-key file.'],
];
let raw='';process.stdin.on('data',(c)=>{raw+=c;});process.stdin.on('error',()=>process.exit(0));process.stdin.on('end',()=>{try{const input=JSON.parse(raw);if(!['Bash','PowerShell'].includes(input.tool_name))process.exit(0);const command=String(input.tool_input?.command??'');const hit=RULES.find(([pattern])=>pattern.test(command));if(hit)console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:hit[1]}}));}catch{}process.exit(0);});
