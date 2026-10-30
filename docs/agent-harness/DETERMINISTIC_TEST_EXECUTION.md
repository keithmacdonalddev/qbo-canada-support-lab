# Deterministic checks: low-cost runner

Owner direction, 2026-10-29, replacing the Luna-only rule recorded on 2026-09-24. Luna used tens of millions of tokens a day, often failed to run requested commands, and was killed at about two minutes per command, while saving little Claude context.

Existing deterministic tests, build/compile, lint/type/syntax, formatting-check and validator commands, including reruns, run through the low-cost Claude `test-runner` subagent (`.claude/agents/test-runner.md`, Claude Haiku). Codex sessions run them directly. If the runner is unavailable, the main agent may run the checks itself and keep only failures in context.

The builder or parent selects the smallest relevant commands, designs tests, inspects source, diagnoses failures and makes fixes. The rule does not authorize live QBO calls, MongoDB mutation, OAuth, service control or broader delegation.

The runner returns each command, exit code and concise failures. It must not fix code, weaken assertions, update snapshots, install dependencies, call live providers or change persistent services. A passing check proves only its own layer.

## Provider-neutral execution bridge (optional)

When a Claude Code or other coding session cannot select Luna directly, use the checked-in script at scripts/agent-harness/luna-exec.mjs. It starts one short-lived Codex CLI session with fixed gpt-6-luna and low-effort settings, then checks the new session transcript for the effective model, exact commands, working directory, exit codes, unrequested actions, and process cleanup. It does not change the current chat's provider or start an app service. Prefer a direct verified Luna subagent when one is available.

Create a request JSON file directly under the ignored `artifacts/luna` directory:

~~~json
{
  "version": 1,
  "cwd": "C:/Projects/qbo",
  "commands": ["node --test scripts/agent-harness/luna-exec.test.mjs"],
  "boundaries": ["Do not edit files, install dependencies, call QBO, or control persistent services."],
  "affectedPaths": ["scripts/agent-harness/luna-exec.mjs"],
  "expectedArtifacts": [],
  "timeoutMs": 600000
}
~~~

After creating the directory and request file, run:

~~~powershell
node scripts/agent-harness/luna-exec.mjs --request artifacts/luna/request.json --receipt artifacts/luna/receipt.json
~~~

The bridge accepts only named non-live check commands and test files in known test directories. Use `node scripts/agent-harness/check-backend-syntax.mjs` for the documented backend-wide syntax check. This command filter is an accident guard; inspect the contents of tests before running them. Requests and new receipts must be JSON files directly under `artifacts/luna`. Existing receipts cannot be overwritten. The receipt and console summary omit command output and runner prose; the underlying Codex transcript may still contain them, so keep that local and do not paste it into chat or tracked files. `artifacts/` is Git-ignored.

A receipt marked passed requires verified Luna/low identity, each exact requested command completed with exit code zero in sequence, and no surviving descendants observed by process-ancestry scans. The runner may first read only the named harness guidance files in at most three `Get-Content` invocations; those reads appear separately in `guidanceReads` and must also succeed in the exact project cwd. For multiple commands, missing launch timing blocks sequence proof. All other extra commands still fail the receipt. Process polling cannot prove that a rapidly detached process did not escape; cleanup evidence has that limit. A failed receipt means the runner or a command failed; blocked means model identity, transcript evidence, permissions or another necessary condition could not be established. Do not infer success from the CLI exit status or the runner's prose alone. The bridge never substitutes a different model and does not grant live-company permission.
