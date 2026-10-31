---
name: project-transcript-redaction
description: Business-agent live transcripts store/stream prompt, reasoning, tool calls/results; redaction gaps to recheck (QBO JWE access tokens, stream recheck scope)
metadata:
  type: project
---

Since 2026-10-30 the business accountant's review sessions (system prompt + context, reasoning, tool inputs/results) are saved to BusinessAgentTranscript (7-day TTL, 1MB/attempt, 50 attempts/agent) and streamed over SSE to anyone with `operations.read` on the company.

**Why:** owner wanted to watch the accountant live. Anything that reaches a tool result or the context now reaches Mongo and the browser, not just the model provider.

**How to apply:** when a new business-agent tool or context field is added, check it cannot carry credentials. Known gaps in the redactor (as of 2026-10-30 review): QBO OAuth access tokens are JWE (`eyJ...` header, then an empty second segment `..`) so the JWT regex misses them as bare strings (only key-name or `access_token=` forms are caught); the SSE access recheck re-binds the user's *current* company rather than the stream's original scope. Related: [[project-production-guard]].
