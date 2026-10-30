#!/usr/bin/env bash
# Confirms the tools this workflow depends on before promising it. Prints one line per check.
cd "$(git rev-parse --show-toplevel)"
ok=0
check(){ if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "MISS  $1"; ok=1; fi; }
check "Codex companion (Sol reviews)" 'ls "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs'
check "Luna bridge (tests)" 'test -f scripts/agent-harness/luna-exec.mjs'
check "agent-browser (UI checks)" 'command -v agent-browser'
check "branch is main" '[ "$(git rev-parse --abbrev-ref HEAD)" = main ]'
check "backend health" 'curl -fs -m 5 http://127.0.0.1:3001/api/health'
exit $ok
