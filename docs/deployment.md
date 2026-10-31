# Deploy Test Data Lab with the owner's Codex subscription

The accountant can run on a persistent server using the owner's ChatGPT login in Codex CLI. The browser does not need Codex installed. Install and authenticate Codex as the **same operating-system account that runs the backend**, and persist its private credential directory across releases. A static frontend host alone cannot run the accountant.

This guide describes deployment steps for the owner/operator to run. No deployment, login, provider request, database change or service action was performed while preparing it.

## Host and installation

Use a trusted Linux host with a supported Node.js runtime, npm, persistent storage, HTTPS and outbound access to OpenAI, Anthropic (if fallback is enabled), Intuit and your MongoDB host. Use a dedicated unprivileged account, such as testdatalab. Install repository dependencies with npm ci from the repository root and build the frontend with npm run build --workspace=frontend. Serve frontend/dist from a web server; route /api to the backend on loopback and preserve streaming responses without buffering.

Install Codex on the backend host, outside the repository:

~~~bash
npm install -g @openai/codex@0.161.0
codex --version
~~~

The adapter's isolation flags and model-catalog handling were built for Codex 0.161.0. Pin that compatible version for this release; test changes before upgrading because removed flags stop inference safely. OpenAI documents the [npm installation method](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex). Set CODEX_CLI_PATH to the absolute executable path visible to the service account. Linux PATH discovery also works; an explicit missing path fails rather than silently selecting another installation. On Windows use the native codex.exe path, not the npm .cmd shim.

## Authenticate on the server

Set CODEX_HOME in the service's private environment to a dedicated persistent directory **outside the checkout and web root**, for example /var/lib/testdatalab/codex. Create it owned by the backend account with directory mode 0700. Provision credentials using that same account and CODEX_HOME.

Preferred headless login (a host without a browser):

~~~bash
codex --ignore-user-config -c 'cli_auth_credentials_store="file"' login --device-auth
~~~

Enable device-code login in the account/workspace settings if required; complete the displayed sign-in in your own browser. Keep the one-time code private. Alternatively, sign in on a trusted computer with file storage, then securely provision its auth.json into the host's CODEX_HOME using SSH or your secret manager. OS-keyring credentials cannot be copied this way. OpenAI documents both [headless login methods and credential storage](https://developers.openai.com/codex/auth/).

Keep auth.json mode 0600, owned by the backend account. The directory must remain writable so Codex can refresh credentials; preserve updated credentials across container/release replacements. Do not bake credentials into images, source control, build artifacts or frontend assets. Restrict backups and secret mounts to the owner and service account. Do not share one writable credential cache across competing hosts. Use Windows ACLs with equivalent account-only access on Windows.

Verify as the service account with the same environment:

~~~bash
codex --ignore-user-config -c 'cli_auth_credentials_store="file"' login status
~~~

It must identify a ChatGPT login. An OpenAI API-key login is separate billing and is not subscription readiness. All app status, catalog and inference commands use file storage consistently; inference also requires ChatGPT login. User Codex config, project rules and native coding tools remain isolated. The app passes only an allowlist of host environment variables to Codex, excluding backend keys and connection strings.

## Environment variables

Provide these through a private process-manager environment file or secret store. Backend startup also reads the ignored root .env as a fallback; do not commit that file or print it to diagnose deployment. This inventory lists names only; obtain the actual values privately.

| Purpose | Names |
| --- | --- |
| Listener and browser origin allowlist | PORT, APP_HOST, APP_ALLOWED_ORIGINS |
| Authentication and account persistence | JWT_SECRET, JWT_EXPIRES_IN, MONGODB_URI |
| QuickBooks connection | QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_ENVIRONMENT |
| Provider selection and host subscription | AI_PROVIDER, CODEX_HOME, CODEX_CLI_PATH, CODEX_MODEL, CODEX_REASONING_EFFORT, CODEX_TIMEOUT_MS |
| Anthropic fallback and enabled key sources | ANTHROPIC_API_KEY, AI_GLOBAL_KEY_ENABLED, AI_USER_KEYS_ENABLED, AI_MODEL_FAST, AI_MODEL_DEEP, AI_MAX_TOKENS, AI_MAX_TOOL_ROUNDS |
| Optional corporate network support | HTTPS_PROXY, HTTP_PROXY, NO_PROXY, SSL_CERT_FILE, CODEX_CA_CERTIFICATE |
| Existing governed-write gates; preserve the approved company configuration | GENERAL_WRITE_DISPATCH_ENABLED, GENERAL_WRITE_INVENTORY_ENABLED, GENERAL_WRITE_INVENTORY_INVOICE_ENABLED, GENERAL_WRITE_INVENTORY_SALES_RECEIPT_ENABLED, GENERAL_WRITE_INVENTORY_BILL_ENABLED, GENERAL_WRITE_INVENTORY_PURCHASE_ENABLED, GENERAL_WRITE_INVENTORY_PURCHASE_ORDER_ENABLED, GENERAL_WRITE_INVENTORY_ESTIMATE_ENABLED |
| Existing legacy gates; leave disabled unless independently required | LEGACY_STARTUP_MAINTENANCE_ENABLED, LEGACY_AI_MUTATIONS_ENABLED, LEGACY_ISSUEPACK_MUTATIONS_ENABLED |

Use a private random JWT secret with at least 32 bytes; startup rejects missing/insecure settings. Keep the API listener on loopback behind HTTPS. Allow only the actual browser origin. The frontend calls same-origin /api; the backend does not serve the Vite build. The local MCP tool bridge uses the configured backend port on 127.0.0.1 and requires Codex to run in the same network namespace. It needs no public tunnel or separate credential provisioning.

## Provider choice, health and fallback

AI_PROVIDER selects auto, codex or anthropic. The default auto selects Codex only when login status identifies ChatGPT. Missing CLI, definite sign-out or API-key login selects Anthropic before a new review. Enable the global key flag with the server key, or enable user keys and save the company owner's key through existing Settings. Anthropic fallback incurs API charges; the app displays that fact. Explicit codex mode requires the subscription and does not fall back. Explicit anthropic mode always uses its enabled key.

A transient status-check failure may retain a successful Codex selection for up to ten minutes. Definite sign-out/API-key results do not receive that grace. Once a review starts, its provider is fixed. A failed run is never replayed automatically through another provider: company tools might already have acted. Codex usage-limit errors retain the existing accountant pause/reset behavior, rather than silently spending on API fallback.

Settings > Assistant > Check again refreshes the host login. The accountant's AI usage & limits section displays host health and offers **Check plan again** when no provider-supplied reset time prevents retry. That authorized control refreshes the host login and retains the existing plan-limit retry behavior. It does not sign in for you, prove remaining quota or grant new accounting authority. A future reset time supplied by Codex remains binding.

The authenticated GET /api/ai/config endpoint reports provider, availability, Codex version, login method, subscriptionReady, checkedAt and a safe recovery reason, plus fallback detail. GET /api/company/business-agent includes the same host diagnostics under usage. Owner-key availability can be unverified until the owner's enabled key is resolved; status never returns the credential. Workspace polling reads cached host health without starting a subprocess; absent or expired health is marked unverified. Settings and Check plan again run bounded local CLI login status/version commands. They do not prompt a model or query QuickBooks. The explicit verifyTools option is a separate inference probe and consumes plan usage; ordinary login checks do not run it.

GET /api/health reports API/database connectivity only. It does not assert accountant, subscription or QuickBooks readiness.

## MongoDB and one backend process

Use authenticated MongoDB with network access restricted to the host (or an allowlisted TLS Atlas connection). Keep the existing database and private backups: company access, QBO refresh tokens, business authority, accepted-write receipts and recovery leases live there. A fresh empty database is not a continuation of this company. Account recovery follows [the existing procedure](account-access-recovery.md).

Run exactly **one backend process** against this company database. QBO token refresh coordination is in process; worker leases do not make multiple token refreshers safe. Before moving the deployment, use existing owner controls to pause/drain work, preserve saved receipts and tokens, and stop the prior backend under separate operational authority. Do not run this PC and the server as simultaneous company writers. Backend startup connects to MongoDB and starts accounting workers under retained authority, so starting a copied database can resume work.

## Process manager and backend command

From the repository root, the production command is:

~~~bash
npm run start --workspace=backend
~~~

Use systemd (or an equivalent persistent process manager) in single-process mode, with no source watcher. Example unit for a Linux layout; adjust executable and checkout paths for the actual host:

~~~ini
[Unit]
Description=Test Data Lab backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=testdatalab
Group=testdatalab
WorkingDirectory=/opt/testdatalab
EnvironmentFile=/etc/testdatalab/backend.env
ExecStart=/usr/bin/node /opt/testdatalab/backend/src/server.js
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=multi-user.target
~~~

Keep backend.env private, readable only by its provisioning administrator; systemd passes it to the service. Include the same CODEX_HOME and absolute Codex path used for sign-in. Configure PATH if npm/Node is installed in a nonstandard location. The credential directory and OS temp directory must permit Codex's restricted subprocesses and temporary files. The frontend is a separately served static build, not npm run dev or Vite preview. Protect logs because company tool results can contain private data. Do not enable/start this unit until the deployment target and company cutover are authorized.

## HTTPS, ngrok and the OAuth callback

Use HTTPS for the app and an exact redirect URI registered in the Intuit application. Match QBO_REDIRECT_URI to that registered URI, including /api/qbo/callback. Keep QBO_ENVIRONMENT consistent with the existing real company. MongoDB holds the saved QBO connection; do not provision it by copying or printing raw tokens.

A stable HTTPS callback on the server can replace ngrok. If retaining a reserved ngrok callback domain, expose only a callback gateway, never the raw backend port. For example, give the reverse proxy a separate loopback listener:

~~~nginx
server {
    listen 127.0.0.1:3002;
    location = /api/qbo/callback {
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }
    location / { return 404; }
}
~~~

Point the reserved ngrok HTTPS domain to that listener, with its ngrok credential in private host configuration. Adjust both ports to the actual listener configuration. Manage ngrok separately from the backend; it is needed only during QBO connect/reconnect, not for Codex device login or normal token refresh. The development launcher's callback-only gateway is described in [development startup](development-startup.md); the production backend command does not launch that gateway or ngrok.

## Release verification

Before a source rollout, run the affected node --test files, npm run build --workspace=frontend, npm run lint --workspace=frontend and git diff --check. The focused provider tests use fake CLI/client responses and never use real credentials, MongoDB or QBO. For a live rollout, separately verify API/database health, host ChatGPT login and Settings health. Only an explicitly authorized accountant review can establish end-to-end inference/tool readiness and actual plan access. Do not use company writes as a deployment smoke test.
