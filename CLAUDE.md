@AGENTS.md

# Claude Code - QBO Support Lab

This file is for Claude Code sessions in `C:\Projects\qbo`.

OpenAI Codex sessions use `AGENTS.md` as the primary project guidance. Claude Code imports that shared guidance above, then uses the Claude-specific architecture below.

## Claude-Specific Architecture

- Durable Claude memory: `.claude/memory/MEMORY.md` and `.claude/memory/project-overview.md`
- Path rules: `.claude/rules/git.md`, `.claude/rules/backend.md`, `.claude/rules/frontend.md`, `.claude/rules/qbo-safety.md`
- Subagents: `.claude/agents/worker.md`, `.claude/agents/implementation-reviewer.md`, `.claude/agents/qbo-safety-reviewer.md`
- Skills: `.claude/skills/qbo-project`, `.claude/skills/qbo-safety-review`, `.claude/skills/qbo-implementation-plan`

## Claude Working Notes

- Treat `AGENTS.md` as the shared project contract.
- Use `.claude/memory/project-overview.md` for stable project facts.
- Use `.claude/memory/MEMORY.md` for durable decisions that should carry into later Claude sessions.
- Use the safety reviewer subagent for work that touches QBO writes, OAuth tokens, user API keys, AI plan execution, or MongoDB state.
- Use the implementation reviewer subagent before considering a task done when the change affects shared backend behavior, AI execution, auth, QBO integration, or route contracts.

## Git And Branch Rule

Claude Code, subagents, and workers inherit the shared `AGENTS.md` Git And Branch Workflow.

- Work in the canonical checkout at `C:\Projects\qbo` on `main` by default.
- Do not use `.claude/worktrees/`, create Git worktrees, switch/create branches, or push non-`main`/`master` branches unless the user explicitly asks for that in the current conversation.
- Before committing or pushing, run `git status --short --branch`. If the session is on anything other than `main` or `master`, is detached, or is inside a worktree path, stop and ask the user before changing branch state.

## Runtime Rule

Do not start, stop, or restart the backend, frontend, OAuth script, QBO validation scripts, or preview server unless the user explicitly asks for that runtime action in the current conversation.

Backend startup is not neutral in this repo: it connects to MongoDB, seeds built-in issue packs, and marks stale jobs/plans failed.

## Secret Rule

Never print `.env`, `.tokens.json`, OAuth tokens, JWT secrets, QBO client secrets, Anthropic API keys, OpenAI API keys, raw Authorization headers, or stored user AI keys.
