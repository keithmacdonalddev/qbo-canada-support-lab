# Compatibility entry; active wiring uses .codex/hooks.json.
$entry = Join-Path $PSScriptRoot '../../scripts/agent-harness/workflow.cjs'
& node $entry prompt
exit $LASTEXITCODE
