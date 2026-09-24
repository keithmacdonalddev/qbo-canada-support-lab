# Coding-agent model selection

This policy covers Codex and Claude Code work on Test Data Lab. It does not select models for the application's AI features or alter saved user/provider settings. User model choices and actual tool availability take precedence over the starting points below.

## Starting choices

| Task | Starting choice | Reason |
| --- | --- | --- |
| Substantial routine coding and tool use in Codex | `gpt-6-sol`, medium | Strong coding and agentic workflow capability with a lower per-token cost than Astra. |
| Difficult architecture, security boundaries, or unresolved cross-cutting diagnosis in Codex | `gpt-6-astra`, high when justified | More reasoning capacity for consequential, ambiguous work. |
| Demanding Claude Code implementation or review | `claude-opus-5-5`, medium initially | Current Opus choice for long-running coding and knowledge work. |
| Existing deterministic tests, builds, lint/type/syntax/format checks and validators | `gpt-6-luna`, low | Required by the [Luna execution contract](DETERMINISTIC_TEST_EXECUTION.md), including reruns. |

Choose based on task difficulty, failure consequences, expected retries and available capabilities. Raise effort only for a concrete need; effort labels are not equivalent across providers. Preserve explicit user choices. Check the effective model and effort at invocation: an inherited role or model name in a file does not prove what ran. If a required model or independent role is unavailable, report that limit. Do not change personal account settings or pin the three core role files to a dated model.

Claude Code roles declare `model: inherit`; a per-invocation override or client policy can change the effective model. Codex core roles also omit model pins. Use the active client's model controls and verify actual selection when it matters. The deterministic-check exception still requires Luna even when a builder or parent uses Sol, Astra or Opus.

Official sources checked 2026-09-24: [OpenAI GPT-6 model guidance](https://developers.openai.com/api/docs/guides/latest-model), [GPT-6 models](https://developers.openai.com/api/docs/models), [Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview), and [Claude Code subagent model selection](https://code.claude.com/docs/en/sub-agents). Recheck these before relying on changing availability, effort support or model behavior.
