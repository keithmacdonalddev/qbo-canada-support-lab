# Coding-Agent Harness Architecture

## Operational baseline

[MODEL_SELECTION.md](docs/agent-harness/MODEL_SELECTION.md) guides task-specific coding-agent model choice. The standing [Luna execution contract](docs/agent-harness/DETERMINISTIC_TEST_EXECUTION.md) is a specific exception for deterministic checks; it is an instruction, not hook enforcement or an application model setting.

[OPERATIONAL_CONTRACT.md](docs/agent-harness/OPERATIONAL_CONTRACT.md) is the current authority for shared hook wiring, explicit-request Git closeout, core role definitions, and activation limits. The layer inventory below reflects this baseline.


## Shared experience and current inventory

Core Codex roles are standalone TOML definitions in `.codex/agents/`; core Claude roles are in `.claude/agents/`. Both clients call `scripts/agent-harness/workflow.cjs` for SessionStart, UserPromptSubmit and PreToolUse. Codex wiring is in `.codex/hooks.json`; Claude wiring is in `.claude/settings.json`. Existing domain roles and project hooks remain separate. Verify host support, project trust and hook trust before calling a hook active.

- [Shared workflow](AGENT_WORKFLOW.md): common communication, outcome, scope, ownership, verification, and closeout behavior for Codex and Claude.
- [Project profile](docs/agent-harness/PROJECT_PROFILE.md): current task routing, commands, project safeguards, declared hooks/roles, and remaining gaps.
- [Outcome and review gates](docs/agent-harness/ACCEPTANCE_AND_REVIEW.md): QBO-specific direct proof, independent review, and proportionate rendered UI inspection.

The profile distinguishes files present from active session behavior. Existing project-specific safeguards remain authoritative. Neither Markdown nor a configured hook proves enforcement; verify the loaded session when that proof matters.


This document explains where coding-agent guidance belongs and what each layer does. `AGENTS.md`, `CLAUDE.md`, current source, and the live-company safety rules remain authoritative when files disagree.

## Shared Layer Map

| Layer | Purpose | This project |
| --- | --- | --- |
| Root instructions | Durable project, branch, safety, and completion rules | `AGENTS.md`, `CLAUDE.md` |
| Scoped rules | Backend, frontend, Git, and live-QBO instructions loaded for matching paths | `.agents/rules/`, `.claude/rules/` |
| Skills | Project orientation, implementation planning, and QBO safety review | `.agents/skills/`, `.claude/skills/` |
| Custom agents | Claude worker, implementation reviewer, and QBO safety reviewer | `.claude/agents/` |
| Hooks | Prompt reinforcement, command blocking, and harness checks | `.claude/hooks/`, `.codex/hooks/` |
| Curated memory | Reviewed project facts and current handoff | `.claude/memory/`, `.codex/memory/` |
| Reviewer memory | Sanitized, evidence-backed reviewer lessons | `.claude/agent-memory/` |
| Local operational records | Raw sessions, hook logs, worktrees, PID files, and temporary state | Gitignored under `.claude/` and `.codex/` |

## Memory Rules

- Current source and root instructions outrank memory.
- Curated memory stores durable facts, not a running diary.
- `project-overview.md` summarizes architecture and live-company boundaries.
- `PROJECT_MEMORY.md` stores durable Codex orientation; `AGENT_HANDOFF.md` stores a short current handoff.
- Existing tracked reviewer-memory files are intentional because they contain curated regression and safety lessons. New entries must be sanitized, evidence-backed, narrowly scoped, and checked for duplication.
- Raw session records, logs, worktrees, PID files, and consolidation state remain local-only.
- Never copy tokens, customer/company data, raw QBO responses, or secrets into any memory file.

## Hook Rules

- `workflow.cjs session-start` checks essential harness files and emits orientation.
- `workflow.cjs prompt` emits the shared reminder and the project-specific addendum.
- `workflow.cjs pre-tool-use` blocks recognized secret dumps, destructive Git, broad staging, and root/ancestor deletion. It emits authorization reminders for service and data operations; valid existing user authorization is reused.
- Old PM/runtime/workspace hook paths are compatibility wrappers and are removed from active settings to avoid duplicate handlers.
- The pre-tool helper returns a generic denial on malformed input or internal inspection errors. Startup and prompt failures report configuration problems. Existing freshness hooks keep their own failure behavior.
- Hook checks are bounded command-pattern checks, not a complete shell sandbox or application authorization system. See the operational contract for activation and coverage limits.

## Skill And Agent Rules

- Use `qbo-project` for orientation.
- Use `qbo-implementation-plan` before broad or high-risk implementation.
- Use `qbo-safety-review` for QBO, OAuth, database, AI execution, secret, or audit changes.
- Claude subagents preload the relevant skill through their `skills` frontmatter field.
- Reviewers are read-only and lead with severity-ranked findings.

## Deliberately Not Used

Raw chat transcripts and a background AI memory process are not permanent project documentation. Important conclusions must be promoted into the appropriate curated memory or authoritative project document after verification.
Automatic retrieval of prior coding chats is not configured for this checkout; current source and curated project notes remain the evidence path.


## Shared core specialists

Both clients define the same optional roles; existing domain specialists remain in place.

| Role | Purpose | Declared permission boundary |
| --- | --- | --- |
| `harness-worker` | Bounded implementation and focused checks | Inherits the parent boundary |
| `harness-reviewer` | Independent correctness and regression review | Codex read-only default; Claude Read/Glob/Grep only |
| `harness-security-reviewer` | Independent security, privacy and integrity review | Codex read-only default; Claude Read/Glob/Grep only |

Definitions are in `.codex/agents/` and `.claude/agents/`. The new files pin no model or reasoning effort. Verify effective permissions and model in the loaded client; parent runtime settings can override Codex sandbox defaults. Availability does not require delegation.
