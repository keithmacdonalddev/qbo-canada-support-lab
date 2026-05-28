---
name: qbo-safety-review
description: QBO Support Lab safety review workflow. Use when changes or reviews touch QuickBooks Online OAuth, QBO API calls, .tokens.json, .env, seeding, generation, issue packs, checkpoints, AI plan/tool execution, stored user AI keys, JWT/auth, audit logging, MongoDB mutation state, backend startup, or any live verification that could mutate QBO or database state.
---

# QBO Safety Review

Use this skill before approving or completing risky QBO Support Lab work.

## Workflow

1. Identify every affected file and route/module boundary.
2. Classify impact:
   - no mutation
   - database-only mutation
   - QBO read
   - QBO write
   - OAuth/token/key handling
   - AI plan/tool execution
   - startup side effect
3. Check the safety gates in `references/safety-checklist.md`.
4. If live verification is needed, separate safe checks from checks that require explicit user approval.
5. Report blockers first. Do not bury QBO mutation, secret, or approval-bypass risk in a summary.

## Review Output Shape

Lead with findings ordered by severity:

- `blocker`: can leak secrets, mutate QBO without approval, bypass auth/company scope, or let AI execute writes unsafely.
- `high`: likely data corruption, broken audit trail, broken token handling, or route exposure.
- `medium`: missing guardrail, unclear UX confirmation, stale docs, insufficient verification.
- `low`: cleanup or maintainability risk.

If no findings exist, say that clearly and list residual risk or skipped live verification.

## Reference

Read `references/safety-checklist.md` for the concrete QBO/API/AI/database checks.
