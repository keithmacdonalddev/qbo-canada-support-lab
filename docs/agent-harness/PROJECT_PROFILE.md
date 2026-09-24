# Test Data Lab application (qbo) agent profile

## Current operational setup

Both clients now have the same three optional core roles and shared SessionStart, UserPromptSubmit and PreToolUse handlers. Git closeout requires an explicit request. See [OPERATIONAL_CONTRACT.md](OPERATIONAL_CONTRACT.md) for the actual coverage and remaining trust/session limits. Project safeguards below remain in force.


Inspected: 2026-09-24. This is the project-specific companion to [the shared workflow](../../AGENT_WORKFLOW.md) and [the harness map](../../AGENT_HARNESS.md). Current source and configuration must be checked before treating a dated inventory as live behavior.

## Purpose

A local control and visibility app for a governed, evolving QuickBooks Online test business. This checkout is the application; the sibling test-data-lab checkout contains its public information pages.

## Read only what the task needs

Paths in the following tables are relative to the repository root. Wildcards mean select the relevant existing file; they are not automatically loaded imports.

| Work | Read |
| --- | --- |
| Product/rebuild | prd.md; roadmap.md; continual-test-data-lab-rebuild-plan.md; REBUILD_RELEASE_EVIDENCE.md |
| Orientation | .agents/skills/qbo-project/SKILL.md |
| Backend/frontend | .agents/rules/backend.md; .agents/rules/frontend.md |
| Live-company safety | .agents/rules/qbo-safety.md; .agents/skills/qbo-safety-review/SKILL.md |
| Branch policy | .agents/rules/git.md |
| Startup | docs/development-startup.md; backend/src/server.js |
| Coding-agent model choice | docs/agent-harness/MODEL_SELECTION.md |
| Deterministic checks | docs/agent-harness/DETERMINISTIC_TEST_EXECUTION.md |
| Substantial outcome, sensitive-path or material UI review | docs/agent-harness/ACCEPTANCE_AND_REVIEW.md |

Codex must explicitly read applicable `.agents/rules/` or scoped `CLAUDE.md` documents listed above; these names do not provide native Codex instruction discovery. Claude loads its own matching rules. A workflow in `.claude/skills/` can be read as a procedure by Codex when relevant, but that does not register a Codex skill or grant its tool permissions.

## Commands and evidence

Only a verified `gpt-6-luna` runner executes the deterministic test, build, lint, syntax, formatting-check and validator commands below, including reruns. Use low reasoning for exact execution and results. See [the execution contract](DETERMINISTIC_TEST_EXECUTION.md). Source and Git inspection remain with the main agent.

Verify the current manifest or build configuration before running a command. Placeholders identify a choice to make from the current source. Commands separated by `/` are alternatives, not a single shell command.

| Command | Purpose and boundary |
| --- | --- |
| `npm run test --workspace=backend` | Non-live backend tests |
| `node scripts/agent-harness/check-backend-syntax.mjs` | Backend-wide non-live syntax check |
| `npm run build --workspace=frontend` | Static frontend build |
| `npm run lint --workspace=frontend` | Frontend lint |
| `npm run test:launcher` | Isolated launcher tests |
| `npm run dev:preview` | Startup preview |
| `npm run dev` | Persistent stack; authorization required |
| `npm run connect / npm run seed` | OAuth/live-company operations; explicit target authorization required, not routine tests |

For documentation changes, inspect references, instruction consistency, supported command names, and the owned diff. App builds and live services are not required merely because agent Markdown changed.

## Project safeguards

- Treat connected-company actions as potentially real operations. Never infer sandbox safety from the word test in the product name.
- Do not run Phase 0 scripts, seed/generate/issue-pack/AI execution, checkpoint, OAuth, or key-saving routes without the existing target-specific authorization.
- Backend startup connects MongoDB. Legacy startup seeding and stale-job rewrites are conditional on server configuration, not unconditional.
- Keep AI writes behind the app approval/tool contracts and company scope. Preserve the canonical-checkout and main/master branch policy.

## Current configuration inventory

Inspected 2026-09-24. This table records files and wiring; trust and actual execution are separate.

| Layer | Contents |
| --- | --- |
| `.agents/skills/` | `qbo-implementation-plan`, `qbo-project`, `qbo-safety-review` |
| `.agents/rules/` | `backend.md`, `frontend.md`, `git.md`, `qbo-safety.md` |
| `.claude/skills/` | `qbo-implementation-plan`, `qbo-project`, `qbo-safety-review` |
| `.claude/rules/` | `backend.md`, `frontend.md`, `git.md`, `qbo-safety.md` |
| `.claude/agents/` | `harness-reviewer.md`, `harness-security-reviewer.md`, `harness-worker.md`, `implementation-reviewer.md`, `qbo-safety-reviewer.md`, `worker.md` |
| `.codex/agents/` | `harness-reviewer.toml`, `harness-security-reviewer.toml`, `harness-worker.toml` |
| Codex shared hooks | `.codex/hooks.json`: SessionStart, UserPromptSubmit, PreToolUse |
| Claude shared hooks | `.claude/settings.json`: SessionStart, UserPromptSubmit, PreToolUse |

## Activation and verification limits

The September 7 record found Codex 0.153.4 discovered the three core hooks but marked them untrusted. [Fresh September 24 sessions](OPERATIONAL_VERIFICATION_2026-09-24.md) on Codex 0.156.1 observed completed SessionStart, UserPromptSubmit and PreToolUse events without bypassing hook trust. Claude Code 2.1.281 observed those events and an effective `claude-opus-5-5` assistant message. The old untrusted result is historical; no new `/hooks` trust listing was needed to prove these handlers ran in the fresh sessions.

The fresh Codex sessions reported effective `gpt-6-sol` and `gpt-6-astra` at low effort. The harness checks passed through a `gpt-6-luna` low-effort runner. Core specialist role invocation and behavior remain unverified; role-file presence does not prove them.

Run `node --test scripts/agent-harness/workflow.test.cjs` and `node scripts/agent-harness/verify.cjs` after harness changes. Existing domain specialists, personal permissions, app safeguards and concurrent work remain separate from the shared baseline.

The Luna bridge has its own focused tests. A Claude-only session can use the [checked-in bridge](DETERMINISTIC_TEST_EXECUTION.md#provider-neutral-execution-bridge) when it cannot select Luna directly; its receipt must prove model, commands, exit codes and cleanup before calling a check passed.

## Session acceptance and maintenance

For a later configuration change, start a fresh session in this checkout and ask the agent to identify its root instructions, shared workflow, project safeguards, and the smallest relevant check without editing or starting services. Claude users can inspect `/context` or `/memory`; Codex users should inspect loaded instructions and available skills in their client. Verify hook execution and effective specialist settings separately when a task depends on them; the September 24 observations cover the core hooks and selected models, not specialist behavior.

Update this profile when commands, source layout, risks, or actual harness wiring change. Keep historical evidence dated, personal settings local, and sibling checkouts independent.
