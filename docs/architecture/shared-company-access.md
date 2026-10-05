# Shared company access

Test Data Lab maintains one QuickBooks company. Its data in the app belongs to the account that holds the company's active QuickBooks connection, the **workspace owner**. That data is cases, AI plans, coverage, the company profile and the audit history.

Another account can work in that company when it has an active `CompanyMembership` for the company's realm. While the owner's connection is active, that account's company requests run in the owner's workspace:

- `req.user.id` is the owner, so the account sees and continues the same cases, plans and coverage.
- `req.user.actorId` is the signed-in account. Audit entries written during the request store it as `actorUserId`, and History shows that account's email.
- Writes to QuickBooks still go through the same plan approval and production confirmation. `AIPlan.approvedBy` records the account that approved.
- AI provider keys are looked up for the signed-in account, never the owner's.
- Codex tool calls arrive on their own MCP request; `ai-tool-bridge.js` binds the starting request's actor so those lookups are attributed correctly.

## Rules

- **An account's own active connection always wins.** A member that connects QuickBooks itself works in its own workspace.
- **Nothing is shared without an active owner connection.** If the owner's connection expires, members fall back to their own workspace.
- **Some actions are never shared.** Connect, reconnect, the manual refresh button and disconnect, sign-in, account settings and stored AI keys stay per account. Only `GET /api/qbo/status` is resolved in the shared scope, and it returns `sharedCompany: true` for a member.
- **The owner's tokens are used.** A member's QuickBooks reads go through the owner's connection, so they can refresh its access token automatically, and a failed health probe can mark it expired, exactly as the owner's own use would.
- **Implementation:** `backend/src/middleware/companyScope.js` (mounted in `backend/src/app.js`), `backend/src/modules/actor-context.js`, and `backend/src/middleware/auditLogger.js`.

## The tester account

The built-in tester password is public: it is in the source and shown on the sign-in page. The backend therefore hands out and accepts those credentials only from this computer (loopback addresses). A tester account that is a member of the real company cannot be used from the network. This holds only while nothing on this computer forwards network traffic to the backend: do not run Vite with `--host` or point a tunnel at port 3001 while the tester is a member.

## Granting and revoking

```
node scripts/company-access.js list
node scripts/company-access.js grant <email> [--role operator]
node scripts/company-access.js revoke <email>
```

The script shares the company with the most recent active connection. It writes only `CompanyMembership` rows and never touches QuickBooks or tokens. Revoking marks the membership `retired`. The account's next request is back in its own workspace.

The membership `role` feeds the rebuild permission model (`/api/context`). Legacy routes do not enforce it yet: any granted account can approve and run writes to the company. The script says so when granting.
