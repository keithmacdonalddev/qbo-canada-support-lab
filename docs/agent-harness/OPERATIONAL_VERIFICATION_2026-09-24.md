# Coding-agent harness verification — 2026-09-24

Scope: Test Data Lab coding-agent model selection, shared hook activation and focused non-live harness checks. No app service, QBO company, database, OAuth flow, Git branch, commit or push was changed.

## Fresh client observations

| Client/session | Direct observation | Limit |
| --- | --- | --- |
| Codex CLI 0.156.1, `gpt-6-sol` at low effort | Session header reported model and effort. `SessionStart` and `UserPromptSubmit` completed. A read-only `git status --short --branch` session showed `PreToolUse` completed. | This proves those handlers ran in these sessions, not every command form or future trust state. |
| Codex CLI 0.156.1, `gpt-6-astra` at low effort | Session header reported model and effort; `SessionStart` and `UserPromptSubmit` completed. | A small read-only smoke request, not a quality evaluation or specialist-role invocation. |
| Claude Code 2.1.281, `claude-opus-5-5` | Stream output reported assistant message model `claude-opus-5-5`; `SessionStart`, `UserPromptSubmit` and `PreToolUse:Bash` hook events started and responded during a read-only Git-status request. | This confirms those hook events and the selected model for this session, not specialist-role behavior. |
| This Codex chat | The startup orientation and prompt reminder matched the shared helper's output. | The fresh CLI events above provide stronger native hook evidence. |

No hook-trust bypass flag was used. The September 7 [historical verification](OPERATIONAL_VERIFICATION_2026-09-07.md) recorded untrusted Codex hooks in an earlier client; it is not the current activation result. Core specialist roles were not invoked, so effective role permissions and inherited model behavior remain unverified.

## Focused static checks

A narrow `gpt-6-luna` runner at low effort executed in `C:\Projects\qbo`:

- `node --test scripts/agent-harness/workflow.test.cjs` — exit 0; 52 passed, 0 failed.
- `node scripts/agent-harness/verify.cjs` — exit 0; 25 checks passed. This checks local wiring and helper output, not client activation.
- `git diff --check` — exit 0; no whitespace errors. Git emitted CRLF conversion warnings for existing working-copy files.

The runner reported no edits, service/provider activity, Git state changes or surviving processes. The model-selection and Luna rules are instructions; the hooks do not enforce model choice. Fresh model smoke requests and static checks do not prove future task quality or live QBO integration.
