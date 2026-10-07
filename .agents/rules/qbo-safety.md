---
paths:
  - "backend/src/modules/qbo-client.js"
  - "backend/src/modules/qbo-error.js"
  - "backend/src/routes/qbo.js"
  - "backend/src/routes/seed.js"
  - "backend/src/routes/generate.js"
  - "backend/src/routes/issuepacks.js"
  - "backend/src/routes/checkpoint.js"
  - "backend/src/routes/ai.js"
  - "scripts/phase-0/**"
---

# QBO Safety Rules

- Assume QBO calls can affect a real connected company unless proven otherwise.
- Do not run QBO OAuth, seed, generation, issue pack, checkpoint creation/deletion, or AI execution paths without explicit current user approval.
- Never print `.tokens.json`, `.env`, OAuth tokens, client secrets, realm credentials, or raw QBO responses that may contain customer/company data.
- Every QBO mutation should have a visible user/company/realm scope and audit trail.
- AI must use internal tool contracts rather than raw QBO endpoints. Reproduce cases use connected-company plus submitted-case authorization without repeated approvals; only case-created records may be edited, voided, deleted or transaction-linked by the agent; deleting or voiding a pre-existing transaction waits for the company owner's approval on the case page and runs only if the record is unchanged; existing records are never edited. Legacy plan execution retains approval flows. See `docs/architecture/autonomous-reproduction.md`. Coding-agent live verification still requires explicit target and approval.
- When surfacing QBO upstream errors, use `backend/src/modules/qbo-error.js` (`respondQboError`): QBO errors map to HTTP 502 (429 passthrough). Never return a QBO-side 401 as an app-level 401 — the frontend force-logs-out the user on any 401.
- Do not add delete/destructive QBO behavior unless the user explicitly asks and the product docs are updated to reflect the risk.
- If verification requires QBO access, report the exact command or route and wait for approval before running it.
