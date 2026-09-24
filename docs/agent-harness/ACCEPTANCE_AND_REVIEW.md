# Coding-agent outcome and review gates

These gates apply to Test Data Lab development work, not to agents inside the application. They add evidence and review for consequential changes while keeping small isolated fixes proportionate.

## Direct outcome evidence

For substantial rebuild work, write a short outcome ledger in the task handoff or existing plan. For each material user outcome, name its direct proof and mark it achieved, unmet, or unverified. Include the relevant parts of the chain:

`business blueprint -> coverage requirement -> controlled operation -> QBO record -> report/reconciliation evidence`

Record the company/environment scope, sanitized counts or identifiers for intended and observed records, audit evidence location, and remaining owner action when those are part of the requested outcome. Keep raw company, customer, and transaction records in an approved private evidence location, not tracked handoffs or plans. A code diff, passing test, static definition, or proposed plan proves only its own layer. If live evidence would require an unauthorized QBO or database action, leave that part unverified and label the delivered foundation or fixture by its actual scope. Never treat a historical phase document as current live proof.

For documentation-only work and small isolated corrections, state the result and its direct file or rendered proof without a formal ledger.

## Independent review

Before completing changes to QBO write paths, OAuth/tokens, stored keys, AI plan/tool execution, MongoDB mutation, backend startup, shared auth or route contracts, or coding-harness command execution, obtain a distinct read-only implementation review and a distinct safety review of the current change and evidence. For a materially new mutation architecture or migration, challenge the scope before source writes as well. A reviewer does not approve its own implementation or authorize live operations.

Claude Code may use its `implementation-reviewer` and `qbo-safety-reviewer`; Codex may use `harness-reviewer` and `harness-security-reviewer`. Verify that the roles and read-only permissions are actually available. Give each reviewer the affected paths, user outcome, safety boundary, and verification evidence. Resolve concrete findings, then review the changed result. If a required reviewer is unavailable, report the review gap rather than claiming independent approval. Small isolated changes outside these boundaries need a concise reason if review is skipped.

## Rendered frontend review

For a material change to a task flow, primary screen, navigation, or shared component, inspect the rendered app on the real affected workflow. Cover relevant initial, loading, empty, success, error, recovery, focus, overflow, and motion states. Check desktop and exactly 390px when responsive web behavior is affected. Use sanitized data and preserve the project's accepted visual direction. Record what was actually observed; a build or screenshot fixture alone is not rendered acceptance.

For a major new visible direction, follow the existing smallest-slice user-acceptance gate before broad adoption. Seek a distinct visual review when a vision-capable reviewer is available; identify that review as unverified when it is not. Respect the rebuild's explicit React interaction, NVDA, and forced-colours release gates rather than silently treating a static build as their completion. A minor localized correction can use focused rendered inspection without a separate design ceremony.

No gate here starts services, changes company data, or grants OAuth or QBO write permission. Apply the existing target-specific authorization rules first.
