# Friendly development startup

Start the complete local application with:

```bash
npm run dev
```

The development launcher checks ports before starting anything, starts the API first, waits for MongoDB and the API health route, and then starts the web app. It turns routine npm, nodemon, and Vite noise into short status lines while leaving unexpected errors visible.

The status symbols have consistent meanings:

- `✅` — a required service or check is ready.
- `ℹ️` — useful context that does not require action.
- `⚠️` — the core app can run, but an optional or task-specific dependency needs attention.
- `❌` — startup cannot safely continue.

The preflight section shows the current branch, commit, local-change state, Node version, and whether ports `3001` and `5173` are safe to use. If Test Data Lab is already healthy on both ports, a second `npm run dev` reports the existing URLs and does not start duplicate services. An unknown port owner stops startup without killing anything.

## Production and ngrok reminder

This local app is configured for a real QuickBooks Online production company. The launcher therefore prints a visible production warning on every startup.

The reserved ngrok tunnel is required only while connecting or reconnecting QuickBooks. The launcher reads only the callback origin from `.env`; it never prints client secrets, tokens, database credentials, API keys, or connected-account details.

When the matching tunnel is offline, startup prints the current configuration-derived command. With the present callback configuration, that command is:

```powershell
ngrok http 3001 --url https://risotto-unbridle-balsamic.ngrok-free.dev
```

Open it in a separate PowerShell window and leave it running. Close any failed authorization popup, then click Connect again so the app creates a fresh OAuth attempt. Normal app use does not require ngrok after the connection is established.

## Useful commands

```bash
# Preview the terminal design without starting, stopping, or checking live services
npm run dev:preview

# Inspect the configured ports and ngrok readiness without starting or stopping services
npm run dev:check

# Show raw npm, nodemon, Vite, and backend output
npm run dev -- --verbose

# Open the app after both required services are ready
npm run dev -- --open

# Show only warnings and errors
npm run dev -- --quiet

# Disable terminal colors explicitly
npm run dev -- --no-color

# Use the former unfiltered concurrently output when troubleshooting the launcher itself
npm run dev:raw
```

Colors are disabled automatically when output is redirected. Press `Ctrl+C` once to stop the API and web process trees created by that launcher. The launcher never kills a process it did not start.

## Verification and maintenance

The focused non-mutating checks are:

```bash
npm run test:launcher
npm run dev:preview
```

Do not run `npm run dev` merely to verify terminal formatting: backend startup connects to MongoDB. Built-in issue-pack seeding and interrupted-run rewrites are now off by default behind `LEGACY_STARTUP_MAINTENANCE_ENABLED`, but an explicit service-start request is still required. Live QuickBooks OAuth and mutation workflows remain separate and require explicit intent.
