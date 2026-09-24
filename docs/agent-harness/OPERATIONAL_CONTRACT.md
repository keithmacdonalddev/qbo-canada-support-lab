# Operational coding-agent contract

Version: 2026-09-24. Both Codex and Claude use the same core behavior, with the project-specific profile and safety focus retained.

## Model selection and check execution

Use [MODEL_SELECTION.md](MODEL_SELECTION.md) for task-specific coding-agent model and effort choices. Existing deterministic tests, builds, syntax/lint/format checks and validators run only through a verified `gpt-6-luna` runner under [DETERMINISTIC_TEST_EXECUTION.md](DETERMINISTIC_TEST_EXECUTION.md). This narrow standing exception applies even when other delegation is optional. It changes neither hook enforcement nor the application's AI models.

Use [ACCEPTANCE_AND_REVIEW.md](ACCEPTANCE_AND_REVIEW.md) for direct QBO outcome proof, independent sensitive-path reviews and proportionate rendered UI checks. These are coding-agent work requirements; they do not authorize live QBO or database operations.

## Git closeout

Commit and push only when the user explicitly requests them. Existing authorization persists within its stated scope; do not ask again. Before an authorized closeout, inspect current branch/upstream, review the staged diff, and stage exact owned files or hunks. Preserve concurrent work. The project's branch, PR, DCO and upstream restrictions still apply. Deployments and external messages require their own authorization.

## Core specialists

Both clients define `harness-worker`, `harness-reviewer`, and `harness-security-reviewer`. They inherit the selected model rather than pinning a dated one. The worker inherits the parent permission boundary; Codex reviewers use a read-only sandbox, and Claude reviewers have only Read/Glob/Grep tools. Native tool availability still needs verification in the loaded client. Codex parent runtime overrides can supersede a role sandbox default; check effective permissions before relying on read-only enforcement. Existing domain and design specialists remain available.

Use these roles for bounded authorized work or required independent review. Their availability does not mandate delegation beyond the Luna check exception. Give the child the parent outcome, exclusions, assigned scope and evidence requirements; the parent verifies the integrated result. QBO company and database safeguards remain in force.

## Shared executable hooks

`scripts/agent-harness/workflow.cjs` is a standalone Node helper with no npm dependencies. It is a development-harness prerequisite, not an application-runtime dependency. Both clients call it for:

| Event | Behavior |
| --- | --- |
| SessionStart | Check essential document/role files and add a concise orientation message |
| UserPromptSubmit | Emit PROMPT_REMINDER.md plus the app's short PROMPT_ADDENDUM.md |
| PreToolUse | Block recognized secret-file dumps, destructive Git commands, broad staging, and workspace-root/ancestor deletion; add targeted authorization reminders for service, Git closeout, deletion, and configured app-operation commands |

Ordinary service actions and data operations are **authorization reminders**, not unconditional bans. A hook does not have a reliable record of conversational approval, so it never claims to authorize these actions or forces a second confirmation after valid approval. Root instructions and the client's permission system remain responsible for authorization. This replaces older service guards that denied even explicitly requested actions.

Hard blocks cover bounded recognized command patterns. They are not a complete shell interpreter, security sandbox, secret scanner, or application authorization system. Shell aliases, arbitrary code in interpreters, and tools outside the configured matcher are not exhaustively inspected. The helper never emits an `allow` permission decision or rewrites a tool request. Host permissions remain in force.

The shared helper reads only its fixed local policy/reminder files. It does not read transcripts, store prompts, log tool commands, contact accounts, or start/stop services. Invalid input to the pre-tool check produces a generic denial without echoing private content; missing startup documents produce a visible warning.

## Configuration and project-specific hooks

Codex wiring lives in `.codex/hooks.json`; project configuration enables hooks. Claude wiring lives in `.claude/settings.json` using executable-plus-argument form. Old PM/runtime/workspace paths are compatibility wrappers, and their former handlers are removed from active settings to prevent contradictory duplicate reminders. Claude's project freshness check remains separate.

Hook paths resolve from the checkout, including when a session starts in a subdirectory. No personal account settings, model pins, approval modes, trust records or application services are changed by this setup.

## Verification and activation

Run `node --test scripts/agent-harness/workflow.test.cjs` for synthetic guard behavior. The tests never execute the dangerous sample commands. Run `node scripts/agent-harness/verify.cjs` for repository wiring, policy, role and reminder checks. App builds are not required for these harness changes.

Codex requires review/trust for new or changed non-managed hooks. Open `/hooks` in a fresh Codex session and review the shared handlers; this setup does not change trust records or bypass that review. Claude uses its normal project trust/settings flow. File/config checks and direct script tests are separate from fresh-session activation proof.

See the [September 24 verification record](OPERATIONAL_VERIFICATION_2026-09-24.md) for current client and hook observations. The [September 7 record](OPERATIONAL_VERIFICATION_2026-09-07.md) remains historical evidence. Update both tool entries and this document when the shared contract changes; retain application-specific safeguards in PROJECT_PROFILE.md and project-policy.json.
