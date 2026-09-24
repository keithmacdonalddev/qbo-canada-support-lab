# Deterministic checks: Luna-only execution

Standing user direction, recorded for this project on 2026-09-24. It applies to Codex and Claude Code coding-agent work; later explicit user restrictions and project safety rules still apply.

Only `gpt-6-luna` executes existing deterministic tests, build/compile, lint/type/syntax, formatting-check and validator commands, including reruns. Use low reasoning for exact execution and pass/fail reporting. Medium is reserved for test selection or ambiguous-output triage. A main agent already on Luna may execute directly. Otherwise use a narrow Luna runner even when no other subagent is needed. If the client cannot select and verify Luna through an authorized route, report the check as blocked; do not substitute another model.

The builder or parent selects the smallest relevant commands, designs tests, inspects source, diagnoses failures and makes fixes. Ordinary source/Git inspection, exploratory browser checks, specialist visual/security judgment, human-run checks and unattended CI are outside this reassignment. The execution rule does not authorize live QBO calls, MongoDB mutation, OAuth, service control or broader delegation.

Give the runner the exact working directory, commands, affected paths and side-effect boundaries. Verify its effective model and effort from the invocation rather than inheritance or self-description. Reuse a runner when practical. Workers unable to delegate return exact commands to their parent.

The runner returns each command, working directory, exit code, concise failures and cleanup evidence. It must not fix code, weaken assertions, update snapshots, install dependencies, call live providers or change persistent services without separate authority. If a check fails, the builder repairs the cause and sends the rerun to Luna. A passing check proves only its own layer.

## Provider-neutral execution bridge

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
