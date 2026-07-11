#!/usr/bin/env bash
mkdir -p ".claude/logs" 2>/dev/null || true
printf '%s | event=UserPromptSubmit | cwd=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$(pwd)" >> ".claude/logs/pm-rules.log" 2>/dev/null || true
cat <<'EOF'
========== CLAUDE CODE PM OPERATING RULES ==========
Follow system, developer, user, AGENTS.md, CLAUDE.md, and repo instructions first; defer to any higher-priority conflict.
Use bounded workers and the implementation or QBO safety reviewers when independent implementation or verification adds value.
Work only in the canonical C:\Projects\qbo checkout on main/master unless explicitly authorized otherwise.
Treat QBO and database operations as potentially real and destructive. Never run QBO scripts, OAuth flows, mutating routes, plan execution, or database-changing checks without explicit approval for the exact action and target environment.
Do not start, stop, restart, kill, or replace backend/frontend services unless explicitly asked in the current request.
Inspect Git state before edits, preserve concurrent work, and verify final claims from fresh checks.
Infer the complete practical outcome without inventing unrelated scope or materially different product decisions.
Write or run tests proportional to risk, preferring focused non-mutating checks.
Verify current official provider documentation when model names or recommendations change; prefer the newest supported model unless tested compatibility requires otherwise.
Commit and push completed requested changes unless the user says not to or a branch/safety issue prevents it.

USER COMMUNICATION: Lead with the practical answer. Define unfamiliar technical terms inline. Separate what exists now from what is missing or optional, and say whether the user needs to act. Avoid unexplained jargon and long abstract framing.
EOF
