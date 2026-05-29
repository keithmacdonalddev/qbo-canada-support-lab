---
name: project-live-production-company
description: The app is connected to a REAL production QuickBooks company — QBO writes are not hypothetical
metadata:
  type: project
---

As of the Dashboard/Lab-Tools split review, the QBO Support Lab ("Test Data Lab") is described as connected to a REAL PRODUCTION QuickBooks company.

**Why:** This raises the stakes of every QBO write path. A guard bypass or accidental mutation hits real accounting data, not a sandbox.

**How to apply:** During safety review, treat any path that can reach a QBO mutation as production-impacting. Do not make live QBO calls, start/stop servers, or run mutating routes during review. Note: the repo's tracked config historically used `QBO_ENVIRONMENT=sandbox` — verify the ACTUAL runtime environment value rather than assuming, since the production guard keys entirely off `config.qbo.environment`. If the live company is production but config reads sandbox, the guard is a silent no-op. Relates to [[project-production-guard]].
