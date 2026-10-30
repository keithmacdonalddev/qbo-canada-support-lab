#!/usr/bin/env bash
# Forwards arguments to the newest installed Codex companion (GPT-6.1 Sol jobs).
# Usage: codex.sh task --background --model gpt-6.1-sol --effort xhigh "<prompt>"
#        codex.sh status <job-id> --json | codex.sh result <job-id>
set -euo pipefail
companion=$(ls -d "$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -1)
[ -n "$companion" ] || { echo "Codex companion not installed (expected under ~/.claude/plugins/cache/openai-codex/codex)." >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)"
NODE_NO_WARNINGS=1 node "$companion" "$@"
