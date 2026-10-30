#!/usr/bin/env bash
# Monitor body: polls a Codex companion job every 60s and prints one line when it ends.
# Usage (as a Monitor command): bash .claude/skills/qbo-team-delivery/scripts/codex-watch.sh <job-id>
set -uo pipefail
job=${1:?job id required}; here=$(dirname "$0")
while true; do
  status=$(bash "$here/codex.sh" status "$job" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.job||j).status)}catch{console.log('unknown')}})")
  case "$status" in completed|failed|cancelled|error) echo "codex job $job $status"; exit 0;; esac
  sleep 60
done
