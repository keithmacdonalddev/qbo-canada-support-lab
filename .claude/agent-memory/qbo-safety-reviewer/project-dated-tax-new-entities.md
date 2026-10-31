---
name: project-dated-tax-new-entities
description: Production business carries the Nova Scotia datedTax schedule; any new taxed transaction type must be admitted by business-dated-tax.js CHARGES or preparation fails. Also: owner consent dialog text is separate from capabilities text.
metadata:
  type: project
---

The published Production business uses the Nova Scotia dated-tax transition (15% before 2025-04-01, 14% after), per docs/agent-harness/FULL_GOAL_EXECUTION.md. Preparation (business-operation-preview.js) attaches `details.datedTax` to every step with a `taxMapping`, and business-tax-policy.js then calls `assertDatedTaxPolicy`, which rejects any entity not in `CHARGES` in business-dated-tax.js.

**Why:** Commit f9cda2b (2026-10-29) added Purchase/VendorCredit to every TAXED allow-list but not to CHARGES, so the new workflows pass sandbox tests (fixture has no datedTax) yet fail at preparation on Production.

Commit de7865c (policy v4) added a second admission path: CreditMemo/RefundReceipt are admitted when `details.activityBatch` is set (same-day batches only); calendar credits still fail.

Also (updated 2026-10-30): `fenceAgentAuthority` (business-agent-authority.js) now accepts any policy in `SAVED_POLICIES` (owner direction 2026-10-29, test-data company), so a policy bump no longer strands batches, but the EXISTING agent grant silently covers each new workflow (e.g. v7 corrections/refunds) without re-consent. Note it as informational on each bump; check the old POLICY is frozen into SAVED_POLICIES with an identical literal. Correction steps (v7) skip datedTax and carry `details.originalTax` instead.

**How to apply:** When reviewing a new taxed workflow, check CHARGES (and the activityBatch exception) and ask whether a test runs with `fixture({datedTax:...})`. Separately, the owner's authority-renewal consent text lives in frontend/src/pages/BusinessWorkspace.jsx `Consent` and is NOT updated by changing `businessAgentCapabilities()`; check both when authority widens. See [[project-live-production-company]].
