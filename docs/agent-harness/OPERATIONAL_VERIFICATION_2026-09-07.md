# Test Data Lab application operational harness verification

Date: 2026-09-07. Scope: coding-agent instructions, role definitions, hooks and local validation. Design impact: nonvisual; no product presentation or interaction change. No application service, database, deployment, commit or push was performed.

## Result

The shared workflow, explicit-request Git policy, three optional core roles, and common SessionStart/UserPromptSubmit/PreToolUse helper are installed for Codex and Claude. Project-specific safeguards and existing specialist/lifecycle definitions remain in place.

## Evidence

- `node --test scripts/agent-harness/workflow.test.cjs`: 52 passed. Samples are inspected as strings; dangerous commands are not executed.
- `node scripts/agent-harness/verify.cjs`: 25 passed. Checks local role/wiring presence and actual helper output.
- JSON/TOML, role frontmatter, script syntax, imports and local links, exact shared-file equality, duplicate-handler checks, actual configured runtime paths, and owned-diff whitespace passed in the cross-project audit.
- Non-hook project settings were compared with the pre-change copies. Existing model, permission and specialist settings were preserved. Alfred's separately handled local settings retained all non-hook keys.
- Real CLI input/output checks covered allowed, denied and malformed requests. These do not prove native-client enforcement for every tool or shell form.

## Installed client observations

Codex discovers all three core hooks as enabled but untrusted. Review and approve them with `/hooks` in a fresh session. Until then they are installed but not expected to execute.

A fresh Claude session was not executed in this checkout. Shared helper behavior and wiring passed locally; a live session, effective role permissions and model behavior remain unverified.

No Codex specialist was spawned. Standalone role files match current documented schema; config/read does not enumerate them as inline agent config. Invocation, inherited model and effective permissions require their own live check when used. Do not claim role discovery from a file-presence test.

## Activation and maintenance

Start a fresh session to load the updated instructions. Apply the trust/login steps above where relevant. See [the operational contract](OPERATIONAL_CONTRACT.md) for behavior and limits and [the project profile](PROJECT_PROFILE.md) for domain routing. Configured command-pattern blocks do not replace user authorization or application controls.

Sanitized local evidence: [operational verification JSON](evidence/operational-verification-2026-09-07.json). This is dated evidence; recheck client state after configuration or trust changes.
