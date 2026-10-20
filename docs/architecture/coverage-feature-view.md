# Intended coverage and company evidence

Coverage defaults to the intended company scope, rather than record-presence results.
The approved business has services/projects, inventory/wholesale and recurring services,
an initial 36-month design horizon, continuing governed activity and explainable reports.
See [research and design rationale](../design/coverage-research.md) for primary sources.

## Requirements and evidence

- **Intended coverage:** business outcomes and representative variations across nine
  business groups, plus app operating requirements. Current record observations sit
  alongside the target without becoming a target-level covered verdict.
- **Feature requirements:** all 24 canonical capability entries, including the 21
  business areas and three app operating requirements. Required variants, prerequisites,
  conditional scope, evidence methods, limitations and approved exclusions remain
  catalog-owned. Search includes variants. Each requirement links available company
  observations and related report evidence.
- **Report requirements:** all 48 project report definitions, including periods,
  populated content, prerequisites and accounting relationships. Deep links open the
  existing per-report retained evidence workflow; this list does not infer results.
- **Company data:** supporting named record/setup observations from the existing
  read-only coverage endpoint. Local filters, old-record handling, limited structural
  evidence, manual instructions, source failures and Explorer links are retained.

The frontend imports the canonical discovery JSON for target definitions. Historical
catalog coverage/implementation statuses and verification dates are never interpreted
as live company findings. Current Canadian Advanced features with no explicit catalog
classification are identified as unresolved scope decisions, not automatically adopted
requirements or missing company records. Release thresholds are targets from PRD §8,
not calculated company achievement.

## Saved company comparison

Only existing GETs for business-plan and business-governance are added. Both read saved
application state without QBO writes or database mutations. Responses must match realm,
environment and connection. Actor/scope changes remount and abort outstanding reads.
Failures remain unavailable rather than becoming zero progress. Proposed defaults are
never shown as saved settings. A current draft matches publication only when its hash
matches the published blueprint hash. The calendar cursor proves only managed period
verification; it does not certify all features, reports, unmanaged history or bank
reconciliation.

The company-data detail panel still provides a separate support-case action only for a
confirmed eligible presence gap. It preserves existing case authorization and never
advances the business calendar. This redesign adds no execution or approval path.

Focused non-live tests: coverage-features.test.mjs and coverage-targets.test.mjs under
frontend/src/lib. Build/lint and actual desktop inspection are recorded in the task evidence.
