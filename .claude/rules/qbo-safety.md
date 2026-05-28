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
- AI must not call raw QBO API endpoints directly. It should use internal tool contracts and approval flows.
- When surfacing QBO upstream errors, use `backend/src/modules/qbo-error.js` (`respondQboError`): QBO errors map to HTTP 502 (429 passthrough). Never return a QBO-side 401 as an app-level 401 — the frontend force-logs-out the user on any 401.
- Do not add delete/destructive QBO behavior unless the user explicitly asks and the product docs are updated to reflect the risk.
- If verification requires QBO access, report the exact command or route and wait for approval before running it.
