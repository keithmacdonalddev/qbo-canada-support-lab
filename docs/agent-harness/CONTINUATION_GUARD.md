# Bounded Codex continuation guard

This checkout adds a Codex Stop handler for the owner's repeated premature-handoff failure. For an explicitly armed session, an unfinished requirement plus a ready step under existing authority returns decision:block, causing Codex to continue. A status report, apology, passing code check, commit or known limitation does not clear a pending requirement.

## Scope and limits

This is a bounded continuation control, not a security boundary, semantic completion oracle, money/token meter or permission grant. It checks declared pending outcomes and the integrity of retained evidence bytes. The agent and outcome reviewers remain responsible for proving that those bytes actually establish the requested result. It does not call providers, run commands, read transcripts, connect to QBO/database, start services, change trust records or create a task from an ordinary question. Other sessions are isolated.

The contract lives in ignored artifacts/agent-continuation/<session UUID>.json. It keeps the original objective, settled decisions, outcome requirements, next actions and absolute deadline. Update only requirement evidence and next-action states; never rewrite the contract to redefine success or renew consumed limits. Keep entries sanitized: no credentials, raw prompts/transcripts or customer records. Readiness describes an existing authorization; it cannot create one.

Each automatic-continuation window is at most 15 minutes, six vetoes total, or three successive vetoes without additional evidence-backed requirements, whichever comes first. Repeated Stop delivery in one turn is idempotent; stop_hook_active is not a bypass. Progress and continue prompts do not renew the original deadline or total count. These bounds constrain automatic re-entry; they are not an assertion of a user-granted spending budget. A smaller actual user limit takes precedence. Exhaustion leaves work explicitly unfinished and requires reassessing the next safe/value-producing action, not claiming completion or silently rearming the same session.

No ready action under existing authority means the guard does not force a retry of a known factual, provider or permission dependency. Check independent work before recording that condition. A declared blocker is not independently proven by this hook.

## Arm and maintain a task

Use the general Node REPL to import the helper from the canonical checkout. This filesystem operation does not run a check or contact a provider:

~~~javascript
var requireGuard = (await import('node:module')).createRequire('C:/Projects/qbo/package.json');
var guard = requireGuard('./scripts/agent-harness/continuation.cjs');
guard.arm('C:/Projects/qbo', sessionId, {
  objective: 'The full requested observable outcome, including its actual scope.',
  decisions: ['A settled owner decision that must not be reopened.'],
  deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  requirements: [{ id: 'requested-outcome', status: 'pending' }],
  nextActions: [{ id: 'next-reviewed-step', status: 'ready', authorization: 'existing' }],
});
~~~

The exact session UUID comes from the current client session, never a guessed thread. Arming an existing session contract is refused. The guard does not retroactively enlarge an existing user time/read/write allowance.

Keep next actions concrete in their IDs and retain their detail in the current task handoff. A next action requiring new authority uses authorization:required and status:blocked; never label it ready to make the loop run. Mark a requirement verified only after direct outcome review, attaching evidence:{path,sha256}. Evidence is limited to bounded JSON files directly under artifacts/goal-realization, artifacts/luna or artifacts/agent-continuation-evidence. The hash is the SHA256 of the file's actual bytes. Missing, changed, oversized, secret-named or linked-outside-workspace evidence cannot satisfy it. Use guard.update(root,sessionId,{requirements,nextActions}); objective, requirement identities, counters and deadline are immutable through that API. As with other local harness controls, a privileged actor can edit files directly; this is not tamper-proof storage.

## Stop, interruption and steering

The native Interrupt event writes a separate atomic pause marker without waiting for the Stop lock. Explicit stop, /stop, pause, /pause, cancel, /cancel, stop working, stop this task, stop now and pause for now also pause continuation. Equivalent the/current-task forms are recognized. Clear replacement wording such as work on X instead pauses the old contract so stale actions are not forced. This conservative grammar does not claim to understand every natural-language cancellation phrase; honor other clear user instructions and use the native interruption control.

An exact continue or resume acknowledges only the captured generation of an ordinary pause marker while retaining all original limits. It does not resurrect a cancelled or replacement task. Ordinary questions, status requests, frustration, quoted stop text and stop waiting for me do not cancel an armed task or create a new one. A pause/dependency/budget exit never certifies completion.

## Configuration, activation and proof

Only this checkout's Codex configuration is changed. Existing workflow handlers remain intact. New Stop, Interrupt and additional UserPromptSubmit handlers invoke continuation.cjs. Windows command strings launch the fixed Node executable through .NET ProcessStartInfo with UseShellExecute=false and CreateNoWindow=true. They redirect stdin/stdout/stderr, bound input and child execution, forward the child exit code, and terminate only their owned child on timeout. This bypasses PowerShell executable/file-association resolution. The continuation module itself launches no child process. Regression tests use hidden bounded processes and clean only their verified temporary roots.

Official native protocol: [Codex hooks](https://developers.openai.com/codex/hooks#stop). A Stop decision:block produces a continuation prompt; Interrupt is a root-session event. New or changed non-managed hook definitions require the client's normal review/trust before execution. Do not bypass that trust, edit personal trust records, or infer activation from configuration files.

Verification layers are separate:

- Fixture/CLI checks prove the handler's behavior and JSON output, including the exact unfinished-status handoff, explicit stops, cancellation under lock contention, blocked actions, evidence changes, retry limits, path containment and session isolation.
- The static harness verifier checks exact event wiring and required no-window process settings. Windows regression tests run the actual configured commands with PATHEXT empty and require valid event-specific JSON, not just exit zero.
- Fresh client execution of a trusted Stop hook must be observed before claiming native automatic continuation is active. Neither of the first two layers proves that.

Required checks run through verified Luna/low: node --test scripts/agent-harness/continuation.test.cjs scripts/agent-harness/workflow.test.cjs, node scripts/agent-harness/verify.cjs, and git diff --check. App builds and QBO writes are unnecessary for this guard.

### Windows launch failure, 2026-10-19

The original quoted executable command failed PowerShell parsing. Adding the invocation operator exposed a second failure: PowerShell treated Node as a document, returned no hook output, and opened visible Node windows despite the parent process being hidden. Do not repeat that native invocation test route. The replacement uses explicit no-window process creation with shell execution disabled; it does not change hook trust, execution policy, or continuation decisions. Subprocess verification and native client reload/trust remain separate facts.
