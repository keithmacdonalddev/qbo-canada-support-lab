#!/usr/bin/env node

const RULES=[
  [/\bnpm\b[^&|;]*\brun\s+dev\b/i,'Service ownership: do not start the QBO backend or frontend unless the user runs it.'],
  [/\bnpm(?:\.cmd)?\b[^&|;]*\b(?:start|connect|seed|ar-chain|ap-chain|read-chains|rate-limits|sales-order)\b/i,'Live QBO protection: this command can start services, authenticate, or mutate/read a real QBO company and requires the user to run it explicitly.'],
  [/\b(?:nodemon|stop-process|taskkill)\b/i,'Service ownership: do not restart or kill persistent processes.'],
  [/\b(?:curl|invoke-webrequest|invoke-restmethod)\b[^\r\n;&|]*\/(?:api\/qbo|api\/seed|api\/generate|api\/issuepacks|api\/checkpoint|api\/ai\/plans)/i,'Live QBO protection: do not call potentially mutating routes from an automated coding session.'],
];
let raw='';process.stdin.on('data',(c)=>{raw+=c;});process.stdin.on('error',()=>process.exit(0));
process.stdin.on('end',()=>{try{const input=JSON.parse(raw);if(!['Bash','PowerShell'].includes(input.tool_name))process.exit(0);const command=String(input.tool_input?.command??'');const hit=RULES.find(([pattern])=>pattern.test(command));if(hit)console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:hit[1]}}));}catch{}process.exit(0);});
