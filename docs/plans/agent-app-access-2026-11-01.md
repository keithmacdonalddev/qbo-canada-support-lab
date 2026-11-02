# Shared local agent app sign-in

Owner-authorized outcome (2026-11-01): local Codex/Claude chats and agents can authenticate without repeated owner prompts into the same existing Test Data Lab account/company.

Scope: separate random, revocable credential attached to the existing account, encrypted with Windows DPAPI CurrentUser outside Git. Preserve owner password, sessions, memberships, account authority and automation settings. Agent sessions use normal server-issued, expiring sessions and current-account checks. No QBO writes or bookkeeping work is part of enrollment.

Direct proof required: enrollment audit; repeated credential reuse; fresh independent agent-browser sessions reach the same account/company and normal rendered bank page; repeat session reuse; invalid/revoked credentials and revoked agent sessions fail while ordinary owner sessions remain valid. Focused auth tests plus separate implementation and safety reviews.

Status: VERIFIED — 2026-11-02T00:20:44.353Z. One credential is enrolled; repeat enrollment reuses it. Two independent fresh native agent-browser sessions returned authenticated/accountMatches/companyMatches true and opened /company/bank. Repeat login reused the valid session. The real desktop bank overview was rendered at 1440×1000 and inspected.

The owner password, role and policy fields match the original snapshot. The shared business write counter advanced normally; it is not an authentication version and no longer participates in session validity. Agent sessions bind to the actual current connection ID, company realm, environment, account version and credential ID. This was corrected after direct reuse evidence exposed the broader counter's semantics; the field-only correction has its own auth audit and did not rotate the secret.

Focused verification: 27 authentication/account/OAuth tests pass. Separate read-only implementation and safety reviews found no remaining blocking issue. Helpers use the installed native browser executable, hidden explicit process arguments for ordinary commands and private stdin for credential operations. No browser-host bypass, execution-policy change, password reset, QBO operation or new app account was used.

Private evidence (ignored): artifacts/agent-login/fresh-logins-final.json, reused-session-final.json, owner-preservation-final.json, stable-binding-correction.json and authenticated-bank.png. The encrypted credential remains outside the checkout under this Windows user's LocalAppData. Shared procedure: [APP_AGENT_LOGIN.md](../agent-harness/APP_AGENT_LOGIN.md).

This verifies shared app access, not BANK-1's remaining four feature downloads, both selected-period journeys and authenticated reload acceptance. Those remain explicit in the BANK-1 assignment.

Final closeout: all four owned verification browser sessions reported inactive with no PID. Backend-wide syntax, 52 workflow checks, the harness validator and diff checks passed. The 27 focused auth/account/OAuth tests passed. Unrelated concurrent accountant/recovery edits remain outside this commit.
