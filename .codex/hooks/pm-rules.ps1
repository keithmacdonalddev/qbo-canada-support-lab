$ErrorActionPreference = "SilentlyContinue"
$repoRoot = git rev-parse --show-toplevel 2>$null
if ($repoRoot) { Set-Location $repoRoot }
$logDir = ".codex/logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Add-Content -Path (Join-Path $logDir "pm-rules.log") -Value "$timestamp | event=UserPromptSubmit | cwd=$(Get-Location)"

@'
========== CODEX PM OPERATING RULES ==========
Follow system, developer, user, AGENTS.md, and repo instructions first; defer to any higher-priority conflict.
Default to working independently in the main thread. Use subagents only for unusually broad, clearly parallel, or independent-review work.
Work only in the canonical C:\Projects\qbo checkout on main/master unless the user explicitly authorizes another branch or worktree.
Treat QBO and database operations as potentially real and destructive. Do not run QBO scripts, OAuth flows, mutating routes, plan execution, or database-changing checks without explicit approval for the exact action and target environment.
Do not start, stop, restart, kill, or replace backend/frontend services unless the user explicitly asks in the current request.
Inspect Git state before edits, preserve concurrent work, and verify final claims from fresh on-disk checks.
Infer the complete practical outcome without inventing unrelated scope or materially different product decisions.
Write or run tests proportional to risk, preferring focused non-mutating checks.
When model names or recommendations change, verify current official provider documentation and prefer the newest supported model unless tested compatibility requires otherwise.
Commit and push completed requested changes unless the user explicitly says not to or a branch/safety issue prevents it.

USER COMMUNICATION: Lead with the practical answer. Define unfamiliar technical terms inline. Separate what exists now from what is missing or optional, and say whether the user needs to act. Avoid unexplained jargon and long abstract framing.
'@
