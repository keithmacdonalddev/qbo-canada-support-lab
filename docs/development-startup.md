# Friendly development startup

Start the complete local application with:

```bash
npm run dev
```

The development launcher checks ports before starting anything, starts the API first, waits for MongoDB and the API health route, and then starts the web app. It verifies that the responding API and web pages belong to Test Data Lab. The API health route returns `503` if MongoDB disconnects. When configured, the launcher also starts the QuickBooks callback tunnel.

The status symbols and colors have consistent meanings:

- `✅` — a required service or check is ready.
- `ℹ️` — useful context that does not require action.
- `⚠️` — the core app can run, but an optional or task-specific dependency needs attention.
- `❌` — startup cannot safely continue.

The blue/purple production heading indicates that the app is configured for the real QuickBooks company. It is a mode label, not an error. The line below it states the consequence: changes you approve affect that company. `App: ready` means the website, local API, and database are available. `QuickBooks sign-in: ready to try` means the local return path is set up, so Connect/Reconnect can be attempted; startup has not completed a real sign-in. Green readiness does not assert that a saved company authorization is valid.

The preflight section shows the current branch, commit, local-change state, Node version, and whether ports `3001` and `5173` are safe to use. If Test Data Lab is already healthy on both ports, a second `npm run dev` reports the existing URLs and does not start duplicate services. An unknown port owner stops startup without killing anything.

Managed startup timestamps every launcher, API, web, and managed ngrok line in local time (`YYYY-MM-DD HH:mm:ss`). Service lines include their `stdout` or `stderr` source. The launcher does not suppress duplicates, stack traces, or multiline details. The API logs QBO request stage, status, error code, message, and Intuit trace ID when available. Common credential patterns are redacted from service lines, while other detail remains visible. Logs may still contain private company data or an unfamiliar secret format; keep terminal output local and inspect it before sharing excerpts. `--verbose` remains accepted for compatibility; full diagnostic output is now the default.

The API and web app reload after source edits, but the `npm run dev` launcher itself does not. If launcher logging code changes while it is running, its old in-memory filter remains active until you stop that launch with Ctrl+C and start `npm run dev` again. A QuickBooks refresh failure now shows a specific category in Settings and records provider status, error fields, and the Intuit reference in the local API log when available. A failure already hidden by an older launcher cannot be recovered from that terminal line.

## Production and QuickBooks sign-in

This local app is configured for a real QuickBooks Online production company. The launcher prints a distinct production heading on every startup.

The reserved ngrok tunnel is required only while connecting or reconnecting QuickBooks. `npm run dev` creates a local gateway that accepts only the QuickBooks OAuth callback, then starts ngrok against that gateway when ngrok is installed and the callback URL is configured. The launcher reads only the callback origin from `.env`. Its ngrok status check confirms the tunnel points to the protected gateway; startup does not make a public callback request.

If ngrok is missing or fails to start, the core app still runs. The launcher prints ngrok's emitted lines and a cause when available, plus a manual command containing the gateway's temporary port. Run that command in a separate PowerShell window while `npm run dev` remains open. Never tunnel API port 3001 directly: it serves other application routes. If a tunnel already targets port 3001, close it before connecting QuickBooks. Close any failed authorization popup, then click Connect again so the app creates a fresh OAuth attempt.

An existing ngrok process may outlive the launcher that created it. If its reserved domain points to a closed local port, ngrok can show `ERR_NGROK_8012`. On a fresh `npm run dev`, the launcher reopens a protected callback gateway on that same unused port and reuses the tunnel. It does not take over a port with a live listener or stop an ngrok process it did not start. `Ctrl+C` stops the current launcher's API, web, gateway, and any ngrok it started; a reused external ngrok process remains running and can be reused again. The startup summary states when this applies.

Stopping the app or its tunnel does not revoke a stored QuickBooks connection. Access tokens are short lived and refresh automatically when the app next calls QuickBooks; the refresh authorization is saved in MongoDB across restarts. The dashboard's read-only health probe can mark a saved connection `expired` only when token refresh explicitly rejects that authorization. Network, rate limit, permission, and server errors remain visible verification errors and keep the saved connection. If an earlier failure already marked it expired, open Settings and choose **Try saved connection**. The app sends the saved token to QuickBooks even when old records lack refresh-lifetime metadata; a missing lifetime no longer causes the SDK to reject the token locally. Reconnect through Onboarding only if QuickBooks rejects the saved authorization. Startup alone does not test or restore a saved authorization.

QuickBooks can still require a new authorization when the refresh token expires, is revoked, or reaches the provider's absolute lifetime. The app cannot make a connection permanent. A refresh-token rotation must be saved immediately; concurrent requests in one API process share one refresh per connection, and a failed MongoDB save is retried from the in-process copy while that API process remains open. Run one API process against this connection database. A multi-instance deployment needs a database-coordinated refresh lock before both instances can safely rotate the same token. A process crash before a token save completes may still require reconnection. See [Intuit's OAuth SDK guidance](https://github.com/intuit/oauth-jsclient) and [refresh-token policy update](https://medium.com/intuitdev/important-changes-to-refresh-token-policy-8443779d40db).

## Useful commands

```bash
# Preview the startup plan without starting, stopping, or checking live services
npm run dev:preview

# Inspect the configured ports and ngrok readiness without starting or stopping services
npm run dev:check

# Compatibility option; full logs are already shown
npm run dev -- --verbose

# Open the app after both required services are ready
npm run dev -- --open

# Quiet launcher status; service output remains complete
npm run dev -- --quiet

# Disable terminal colors explicitly
npm run dev -- --no-color

# Legacy direct backend/web runner without managed callback gateway
npm run dev:raw
```

Colors are disabled automatically when output is redirected. Press `Ctrl+C` once to stop the API, web, and ngrok processes created by that launcher. The launcher never kills a process it did not start. On Windows, Ctrl+C may end a service just before the launcher's stop command reaches it; the launcher now checks whether that process and its local service port have actually closed before reporting a shutdown error. If a process remains, the message includes Windows' reason when available and identifies any port still listening. Inspect that port's owner before restarting; do not assume a nonzero `taskkill` result means the app is still running.

## Verification and maintenance

The focused non-mutating checks are:

```bash
npm run test:launcher
npm run dev:preview
```

Do not run `npm run dev` merely to verify terminal formatting: backend startup connects to MongoDB. Built-in issue-pack seeding and interrupted-run rewrites are now off by default behind `LEGACY_STARTUP_MAINTENANCE_ENABLED`, but an explicit service-start request is still required. Live QuickBooks OAuth and mutation workflows remain separate and require explicit intent.
