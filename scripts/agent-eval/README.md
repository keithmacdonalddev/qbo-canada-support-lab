# Reproduce agent scenario evaluation

A repeatable check of how the real Reproduce agent behaves across a varied set of support requests. Each scenario runs through the real engine (`backend/src/modules/reproduction-engine.js`), its real system prompt and the real model provider path (`reproduction-runner.js` `runProvider`), against an in-memory **simulated** QuickBooks Online Canada company. A deterministic grader then checks the result.

## What it touches

- **Makes live model-provider calls.** With Codex (the default when signed in) this uses the owner's ChatGPT subscription; with `--provider anthropic` it needs `ANTHROPIC_API_KEY` in the environment. A full run is 27 agent cases.
- **Never calls QuickBooks or MongoDB.** `guard.js` replaces the real `qbo-client` in Node's require cache with a stub that throws, stubs the database connector and makes mongoose refuse to connect. Only non-secret provider settings (`AI_PROVIDER`, `CODEX_*`, `AI_MODEL_*`, `AI_MAX_TOKENS`) are read from `.env`.
- Codex reaches the case tools over HTTP MCP. The runner serves that endpoint from its own short-lived server on a free localhost port, so the owner's running backend (port 3001) is not involved. Nothing is started or stopped.

## Running

```
node scripts/agent-eval/run.js --list
node scripts/agent-eval/run.js --scenario owner-distribution-transfer
node scripts/agent-eval/run.js --all --concurrency 3
```

Options: `--scenario <id>` (repeatable), `--all`, `--concurrency N` (default 3), `--json <file>` (extra copy of the report), `--provider codex|anthropic`, `--model <codex model>`, `--effort low|medium|high|xhigh`, `--skip-preflight` (skip the Codex tool-access probe).

The console shows one line per scenario, then a table: scenario, outcome, tool calls, writes, pass/fail and the first failing note. The full report (agent replies, tool trace, simulated-company call log, created records, grader notes) is written to `artifacts/agent-eval/<timestamp>.json`; `artifacts/` is Git-ignored. Exit code 0 means every selected scenario passed, 1 means at least one failed, 2 means the harness could not run.

Run it after any change to the Reproduce prompt, tools, engine, provider adapter or Codex settings, and after every Codex CLI upgrade. A model that cannot see its tools shows up as `no tool calls at all`.

## Files

- `fake-qbo.js` - the simulated company (Maple Ridge Supply Co.): chart of accounts, Canadian tax codes (HST ON 13%, GST 5%, Exempt, Zero-rated, Out of Scope), items including one inventory item, customers, vendors and a few existing transactions (invoices 1001-1003, a payment, a bill, opening balances). It implements the client surface the tools use: `read`, `query`, `create`, `update`, `apiCall` (delete, void, reports) and `getLastIntuitTid`. Balances, links, statuses and inventory are derived from the stored transactions. Every call is logged for grading.
- `scenarios.js` - the scenarios and graders, plus universal checks applied to every scenario: at least one tool call; each run ends with `finishCase` or `askOperator`; no invented Ids; no changes to records that existed before the case (owner-approval requests excepted); the outcome agrees with the recorded checks.
- `harness.js` - runs one scenario with an injected model adapter, mirroring how `reproduction-runner.js` builds the transcript and continues a case after an operator reply. Keep it in step with the runner.
- `run.js` - the command-line runner. `guard.js` - the QuickBooks/MongoDB guard.
- Non-live unit tests: `backend/test/agent-eval-fake-qbo.test.js` and `backend/test/agent-eval-harness.test.js` drive the same code with scripted model replies.

## Adding a scenario

Add an object to `scenarios` in `scenarios.js`:

```js
{
  id: 'short-kebab-id',
  title: 'One line for the table',
  request: 'The operator message, written like a real support request.',
  // or turns: ['first message', { message: 'operator reply', onlyIf: 'needs_input' }],
  grade(ctx) {
    const g = grader();
    if (!expectCompleted(ctx, g)) return g.result();
    // Inspect ctx.company (created(), get(), postings(), qtyOnHand()), ctx.state,
    // ctx.plan.steps, ctx.trace (tool calls) and ctx.calls (simulated QBO calls).
    return g.result();
  },
}
```

Grade the observable result in the company, not the wording of the reply, and accept every reasonable way of recording the request (for example a transfer or an equivalent journal entry). Use `g.info()` for notes that should not fail the scenario. If the request needs seed data that does not exist, add it to `seedCompany()` in `fake-qbo.js` with a fixed Id.

## Limits of the simulated company

It is a pragmatic model, not a QuickBooks clone. Validation covers common mistakes (missing references, unknown Ids, invalid account types, unbalanced journal entries, transfers within one account or to non-balance-sheet accounts, missing GST/HST codes on sales and purchase lines, over-applied payments, stale SyncTokens) with QBO-style messages, but QuickBooks enforces many rules this does not, and some messages differ from the real wording. Account detail types are only partly validated. Tax uses one rate per code; discounts, multicurrency, classes/locations, projects, sales tax agencies and returns, automatic credit application, recurring transactions, attachments, bank feeds and reconciliation are not modelled. Reports are simplified Accrual layouts (Balance Sheet, Profit and Loss, Trial Balance, General Ledger, A/R and A/P balances without aging buckets, Account List, Inventory Valuation); CompanyInfo and Preferences are readable; other reports return no data. There is no screen companion, so `checkScreen` is unavailable, as in a server-only case. A pass here shows the agent's reasoning and tool use; it does not prove the same payload is accepted by the real company.
