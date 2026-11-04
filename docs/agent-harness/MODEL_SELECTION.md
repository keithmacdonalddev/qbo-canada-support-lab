# Coding-agent model selection

This policy covers Codex and Claude Code work on Test Data Lab. It does not select models for the application's AI features or alter saved user/provider settings. User model choices and actual tool availability take precedence over the starting points below.

## Starting choices

| Task | Starting choice | Reason |
| --- | --- | --- |
| Substantial routine coding and tool use in Codex | `gpt-6-sol`, medium | Strong coding and agentic workflow capability with a lower per-token cost than Astra. |
| Difficult architecture, security boundaries, or unresolved cross-cutting diagnosis in Codex | `gpt-6-astra`, high when justified | More reasoning capacity for consequential, ambiguous work. |
| Demanding Claude Code implementation or review | `claude-opus-5-5`, medium initially | Current Opus choice for long-running coding and knowledge work. |
| Browser navigation, native QBO work, local-app flows and rendered inspection | `gpt-6.1-terra` subagent, `medium` or `high` | Owner-required browser delegation; one exact, bounded, verifiable task. `medium` for routine tasks, `high` for a concrete difficult case. Parent verifies effective settings and saved evidence. |
| Existing deterministic tests, builds, lint/type/syntax/format checks and validators | Claude Haiku `test-runner` subagent (Codex: direct) | Per the [execution contract](DETERMINISTIC_TEST_EXECUTION.md), including reruns. Luna bridge optional. |

Choose based on task difficulty, failure consequences, expected retries and available capabilities. Raise effort only for a concrete need; effort labels are not equivalent across providers. Preserve explicit user choices. Check the effective model and effort at invocation: an inherited role or model name in a file does not prove what ran. If a required model or independent role is unavailable, report that limit. Do not change personal account settings or pin the three core role files to a dated model.

Claude Code roles declare `model: inherit`; a per-invocation override or client policy can change the effective model. Codex core roles also omit model pins. Use the active client's model controls and verify actual selection when it matters. Deterministic checks follow the execution contract: Claude Haiku test-runner, or direct execution in Codex; the Luna bridge is optional.

Official sources checked 2026-09-24: [OpenAI GPT-6 model guidance](https://developers.openai.com/api/docs/guides/latest-model), [GPT-6 models](https://developers.openai.com/api/docs/models), [Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview), and [Claude Code subagent model selection](https://code.claude.com/docs/en/sub-agents). Recheck these before relying on changing availability, effort support or model behavior.

Owner browser rule checked2026-11-04: the [official GPT-6.1 Terra model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-terra) identifies `gpt-6.1-terra` and supports `medium`/`high`. The owner requires those two efforts for browser subagents even though the model and legacy runner support other efforts. This rule does not change application AI settings. See the [required task contract](../../.claude/skills/qbo-team-delivery/references/terra.md#required-task-contract).
