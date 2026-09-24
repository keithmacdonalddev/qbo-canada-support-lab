#!/usr/bin/env bash
# Compatibility entry; active wiring uses the shared Node helper.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../../scripts/agent-harness/workflow.cjs" prompt
