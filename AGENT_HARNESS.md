# Coding-Agent Harness Architecture

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

- `pm-rules` repeats the critical communication, branch, live-QBO, and completion rules.
- `runtime-guard` mechanically blocks service-control and known live-mutation commands.
- `harness-freshness` warns when required harness files are missing or curated memory is visibly stale.
- Hooks fail open on internal errors; safety still depends on the root rules and explicit user approval.

## Skill And Agent Rules

- Use `qbo-project` for orientation.
- Use `qbo-implementation-plan` before broad or high-risk implementation.
- Use `qbo-safety-review` for QBO, OAuth, database, AI execution, secret, or audit changes.
- Claude subagents preload the relevant skill through their `skills` frontmatter field.
- Reviewers are read-only and lead with severity-ranked findings.

## Deliberately Not Used

Raw chat transcripts and a background AI memory process are not permanent project documentation. Important conclusions must be promoted into the appropriate curated memory or authoritative project document after verification.
