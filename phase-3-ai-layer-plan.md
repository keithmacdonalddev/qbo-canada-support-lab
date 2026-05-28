# Phase 3 — AI Layer Plan

**Status:** Implemented in source; acceptance testing and hardening needed
**Depends on:** Phase 2 complete (Gate C passed)
**Phase objective:** Add controlled AI assistance on top of the deterministic tools built in Phases 1-2.

---

## Current Implementation Status

Phase 3 source surfaces are present:

- `backend/src/modules/ai-provider.js`
- `backend/src/modules/ai-orchestrator.js`
- `backend/src/modules/ai-tools.js`
- `backend/src/modules/ai-notes.js`
- `backend/src/routes/ai.js`
- `backend/src/models/AISession.js`
- `backend/src/models/AIPlan.js`
- `frontend/src/pages/AICommandCenter.jsx`
- `frontend/src/components/ai/`

Current non-mutating verification as of 2026-05-28:

- frontend build passes
- backend syntax check passes
- frontend lint fails on current AI UI lint debt:
  - unused variables/imports in AI UI files
  - React hook dependency warnings in `AICommandCenter.jsx`
- `npm audit --omit=dev` reports production vulnerabilities, including high-severity Axios advisories and a moderate Anthropic SDK advisory.

Still needed before Phase 3 can be treated as product-complete:

- AI key setup verification using the intended global/user-key mode
- chat/session flow acceptance test
- plan propose/approve/reject/execute acceptance test
- SSE stream ticket/connection acceptance test
- support note generation acceptance test
- audit-log verification for every AI action
- QBO safety review of all write-capable AI tools

Update (2026-05-28): the AI route (`backend/src/routes/ai.js`) now surfaces QBO upstream errors hit while executing AI plan/tool steps through `backend/src/modules/qbo-error.js` (HTTP 502, 429 passed through, body carries `intuit_tid` and `qboStatus`), on branch `fix/qbo-client-error-handling` (committed, not yet merged). This complements the Claude API error handling in Section 5.10 — that section covers errors from the model; this covers errors from the QBO tools the model drives. Frontend plan approve/reject/execute failures now raise a toast (new `components/ui/toast.jsx`). Re-run the plan execution acceptance test on this branch once merged.

---

## 1. Phase outcome

At the end of Phase 3, a user should be able to:

- Type a natural language request ("create an AR discrepancy involving partial payments for Maple Corp")
- See an AI-generated execution plan with discrete, reviewable steps
- Approve, edit, or reject the plan before any writes happen
- Watch approved steps execute against their QBO company in real time
- Ask the AI to investigate a discrepancy ("why does this customer's balance not match?")
- Receive evidence-based explanations with links to specific entities
- Generate structured, copy-ready support notes from any investigation
- See full AI session history with every plan, approval, and execution logged

**Exit criteria (from PRD):** A user can describe an issue in natural language, review an AI-proposed plan, approve execution, and receive a generated support note with evidence references.

---

## 2. Entry criteria (Gate C)

Phase 3 starts only after Phase 2 provides:

- Investigation tools (entity explorer, chain resolver) already useful without AI
- At least 3 issue packs stable and reproducible
- Checkpoints and diffs trustworthy enough for evidence-based explanations
- Historical generation producing 150+ linked transactions across 6 months

All confirmed complete as of commit `bf8f3c6`.

---

## 3. Scope

### In scope

1. **Anthropic Claude SDK integration** — provider module with model selection and streaming
2. **AI tool contracts** — 12 tools mapping to existing backend modules (6 read-only auto-approved, 6 write requiring confirmation)
3. **AI session model** — conversation persistence, plan storage, approval tracking
4. **AI orchestration module** — prompt construction, tool dispatch, plan parsing, confirmation flow
5. **Confirmed execution flow** — plan → review → approve → execute → audit
6. **NL scenario planning** — natural language to structured execution plan
7. **Investigation assistance** — discrepancy analysis with evidence references
8. **Support note generation** — structured, copy-ready output from any investigation or session
9. **AI Command Center page** — chat interface, plan display, approval UI, session history
10. **AI session audit logging** — every AI action logged with `aiDriven: true`
11. **SSE streaming** — real-time AI response streaming to frontend

### Out of scope (Phase 4+)

- Guarded auto-execution (start with suggest + confirmed only)
- Custom issue pack creation via AI
- Continuous activity engine
- AI model swappability UI (abstract the interface, but single provider for now)
- Multi-turn autonomous agent loops (AI proposes one plan at a time)

---

## 4. Architecture

### 4.1 New backend modules

```
backend/src/
  modules/
    ai-provider.js           # NEW — Anthropic SDK wrapper, model config, streaming
    ai-orchestrator.js        # NEW — prompt construction, tool dispatch, plan lifecycle
    ai-tools.js               # NEW — tool contract definitions (schema + handlers)
    ai-notes.js               # NEW — support note generation and formatting
```

### 4.2 New models

```
backend/src/models/
  AISession.js                # Conversation history, plans, approvals, execution results
  AIPlan.js                   # Individual execution plans with step-level status tracking
```

### 4.3 New routes

```
backend/src/routes/
  ai.js                       # POST /chat, POST /plan/:id/approve, POST /plan/:id/reject,
                              # POST /plan/:id/execute, GET /sessions, GET /sessions/:id,
                              # POST /investigate, POST /generate-note, GET /stream/:sessionId
```

### 4.4 New frontend pages and components

```
frontend/src/
  pages/
    AICommandCenter.jsx       # Main AI interface — chat + plan + execution + notes
  components/
    ai/
      ChatPanel.jsx           # Message input, conversation history, streaming display
      PlanReview.jsx          # Structured plan display with per-step approve/reject
      ExecutionLog.jsx        # Real-time execution progress with step status
      SupportNote.jsx         # Rendered note with copy button and export
      SessionHistory.jsx      # Past AI sessions list with resume capability
```

### 4.5 Frontend route additions

```
/ai                           # AI Command Center
/ai/session/:id               # Resume a previous session
```

### 4.6 System architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│                                                              │
│  AI Command Center                                           │
│  ┌──────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Chat     │ │ Plan Review  │ │ Execution Log            │ │
│  │ Panel    │ │ (approve/    │ │ (real-time SSE)          │ │
│  │          │ │  reject)     │ │                          │ │
│  └────┬─────┘ └──────┬───────┘ └────────┬─────────────────┘ │
│       │              │                   │                   │
│       └──────────────┼───────────────────┘                   │
│                      │ REST + SSE                            │
├──────────────────────┼──────────────────────────────────────┤
│                      │ Backend                               │
│                      ▼                                       │
│  ┌──────────────────────────────────────┐                    │
│  │         AI Routes (/api/ai/*)        │                    │
│  └──────────────┬───────────────────────┘                    │
│                 │                                            │
│  ┌──────────────▼───────────────────────┐                    │
│  │        AI Orchestrator               │                    │
│  │  - Prompt construction               │                    │
│  │  - Tool dispatch                     │                    │
│  │  - Plan lifecycle                    │                    │
│  │  - Confirmation enforcement          │                    │
│  └──┬───────────┬───────────────────────┘                    │
│     │           │                                            │
│  ┌──▼──┐  ┌────▼─────────────────────────┐                   │
│  │ AI  │  │     AI Tool Contracts         │                   │
│  │Prov.│  │                               │                   │
│  │     │  │  READ (auto):                 │                   │
│  │Claude│ │  lookupCustomer               │                   │
│  │ API │  │  lookupInvoice                │                   │
│  │     │  │  getTransactionChain          │                   │
│  └─────┘  │  getChangeSummary             │                   │
│           │  searchEntities               │                   │
│           │  getEntityDetail              │                   │
│           │                               │                   │
│           │  WRITE (confirm):             │                   │
│           │  createInvoice                │                   │
│           │  applyPayment                 │                   │
│           │  createBill                   │                   │
│           │  applyBillPayment             │                   │
│           │  runIssuePack                 │                   │
│           │  createCheckpoint             │                   │
│           │                               │                   │
│           │  AI-ONLY (auto):              │                   │
│           │  explainDiscrepancy           │                   │
│           │  generateSupportNote          │                   │
│           └──────────┬────────────────────┘                   │
│                      │ delegates to                          │
│           ┌──────────▼────────────────────┐                   │
│           │  Existing Phase 1-2 Modules   │                   │
│           │  qbo-client.js                │                   │
│           │  generation-engine.js         │                   │
│           │  issuepack-engine.js          │                   │
│           │  checkpoint.js                │                   │
│           │  explore routes (search/chain)│                   │
│           └───────────────────────────────┘                   │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐                    │
│  │   AISession      │  │   AuditLog      │                    │
│  │   AIPlan         │  │   (aiDriven)    │                    │
│  │   (MongoDB)      │  │   (MongoDB)     │                    │
│  └─────────────────┘  └─────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Detailed design

### 5.1 AI provider module (`ai-provider.js`)

**Purpose:** Thin wrapper around the Anthropic SDK. Isolates the provider choice so a future swap is one-file change.

**Implementation:**
- Install `@anthropic-ai/sdk`
- Add `ANTHROPIC_API_KEY` to `.env` and `config/index.js`
- Two model tiers:
  - **Fast** (Claude Sonnet 4): tool use, plan generation, investigation — most interactions
  - **Deep** (Claude Opus 4): complex multi-entity discrepancy analysis — on-demand
- Streaming via Anthropic SDK's `stream()` method
- Token usage tracking per session (logged, not billed — internal tool)

```js
// ai-provider.js — public API surface
module.exports = {
  chat(messages, tools, options),        // single response (awaited)
  stream(messages, tools, options),      // SSE-compatible stream
  MODELS: { FAST: 'claude-sonnet-4-6', DEEP: 'claude-opus-4-6' },
};
```

**System prompt structure:**
```
You are the AI assistant for the QBO Canada Support Lab. You help support
agents reproduce customer issues, investigate discrepancies, and generate
support notes.

Context:
- Company: {companyName} (Realm: {realmId})
- Subscription: {tier}
- Seeded entities: {entityCounts}
- Active issue packs: {activeIssuePacks}
- Last checkpoint: {lastCheckpoint}

Rules:
- All write operations require user confirmation before execution.
- You can freely read/search/inspect entities without confirmation.
- Always reference specific entity IDs and amounts in your explanations.
- When proposing a plan, break it into discrete numbered steps.
- Each step must map to exactly one tool call.
- Never fabricate entity IDs — always look them up first.
```

### 5.2 AI tool contracts (`ai-tools.js`)

Each tool is defined with a name, description, input JSON schema (for Claude tool_use), a handler function, and a permission level.

**Read tools (auto-approved — no confirmation needed):**

| Tool | Description | Input | Handler | Maps to |
|------|-------------|-------|---------|---------|
| `lookupCustomer` | Find customers by name | `{ name: string }` | QBO query | `explore.js` search |
| `lookupInvoice` | Find invoices by number or customer | `{ docNumber?: string, customerName?: string }` | QBO query | `explore.js` search |
| `searchEntities` | Search any entity type | `{ type: string, query: string, limit?: number }` | QBO query | `explore.js` search |
| `getEntityDetail` | Get full record by type and ID | `{ type: string, id: string }` | QBO read | `explore.js` /:entity/:id |
| `getTransactionChain` | Trace linked transactions from a starting record | `{ entityType: string, entityId: string }` | Chain resolver | `explore.js` chain |
| `getChangeSummary` | Summarize changes between two checkpoints or since a date | `{ checkpointA?: string, checkpointB?: string, since?: string }` | Diff engine | `checkpoint.js` diff |

**Write tools (require confirmation before execution):**

| Tool | Description | Input | Handler | Maps to |
|------|-------------|-------|---------|---------|
| `createInvoice` | Create a new invoice | `{ customerRef: {id, name}, lines: [...], txnDate: string }` | QBO create | `qbo-client.js` create |
| `applyPayment` | Apply a payment to an invoice | `{ customerRef: {id, name}, invoiceId: string, amount: number, txnDate: string }` | QBO create | `qbo-client.js` create |
| `createBill` | Create a new bill | `{ vendorRef: {id, name}, lines: [...], txnDate: string }` | QBO create | `qbo-client.js` create |
| `applyBillPayment` | Pay a bill | `{ vendorRef: {id, name}, billId: string, amount: number, txnDate: string }` | QBO create | `qbo-client.js` create |
| `runIssuePack` | Execute a named issue pack | `{ packId: string }` | Issue engine | `issuepacks.js` execute |
| `createCheckpoint` | Snapshot current company state | `{ name: string, description?: string }` | Checkpoint engine | `checkpoint.js` create |

**AI-only tools (auto-approved — pure computation, no QBO writes):**

| Tool | Description | Input | Handler |
|------|-------------|-------|---------|
| `explainDiscrepancy` | Analyze evidence and produce a structured explanation | `{ findings: object[], hypothesis: string }` | AI reasoning (no external call) |
| `generateSupportNote` | Produce a formatted support note | `{ investigation: object, format: 'escalation' \| 'internal' \| 'customer' }` | AI generation (no external call) |

**Tool handler pattern:**

```js
// Each tool handler receives context and returns a result
async function handleLookupCustomer(input, context) {
  const { qbo, userId, realmId } = context;
  const result = await qbo.query(
    `SELECT * FROM Customer WHERE DisplayName LIKE '%${sanitize(input.name)}%' MAXRESULTS 10`
  );
  const customers = result.QueryResponse?.Customer || [];
  return {
    success: true,
    data: customers.map(c => ({
      id: c.Id,
      name: c.DisplayName,
      balance: c.Balance,
      active: c.Active,
    })),
  };
}
```

**Security:** All tool inputs are sanitized. Write tools are never executed directly — they return a plan step that must be approved first. The orchestrator enforces this: if Claude emits a write tool call during a `suggest` or `plan` phase, the orchestrator converts it to a plan step rather than executing it.

### 5.3 AI session model (`AISession.js`)

```js
{
  userId: ObjectId,
  realmId: String,
  title: String,                    // auto-generated from first message
  status: enum ['active', 'completed', 'archived'],
  mode: enum ['suggest', 'investigate', 'generate_note'],
  messages: [{
    role: enum ['user', 'assistant', 'system', 'tool_result'],
    content: String,
    toolCalls: [{                   // when role=assistant and Claude used tools
      toolName: String,
      input: Mixed,
      result: Mixed,
    }],
    timestamp: Date,
  }],
  plans: [ObjectId],               // references to AIPlan documents
  tokenUsage: {
    inputTokens: Number,
    outputTokens: Number,
  },
  model: String,                    // which Claude model was used
  createdAt: Date,
  updatedAt: Date,
}
```

### 5.4 AI plan model (`AIPlan.js`)

```js
{
  sessionId: ObjectId,
  userId: ObjectId,
  realmId: String,
  status: enum ['proposed', 'approved', 'partially_approved', 'rejected', 'executing', 'completed', 'failed'],
  description: String,              // AI's summary of what this plan does
  steps: [{
    stepNumber: Number,
    description: String,            // human-readable ("Create invoice for $5,000 to Maple Corp")
    toolName: String,               // "createInvoice"
    toolInput: Mixed,               // the exact input for the tool
    requiresConfirmation: Boolean,  // true for write tools
    status: enum ['pending', 'approved', 'rejected', 'executing', 'completed', 'failed', 'skipped'],
    result: Mixed,                  // tool execution result
    error: String,
    executedAt: Date,
  }],
  approvedAt: Date,
  approvedBy: ObjectId,             // userId who approved
  completedAt: Date,
  createdAt: Date,
}
```

### 5.5 AI orchestrator (`ai-orchestrator.js`)

The orchestrator is the brain of Phase 3. It manages the full lifecycle:

**Flow 1: Natural language planning**
```
User message → orchestrator.chat()
  1. Build system prompt with company context
  2. Append conversation history from AISession
  3. Send to Claude with all tool definitions
  4. If Claude uses read tools → execute immediately, feed results back
  5. If Claude uses write tools → DO NOT execute; convert to AIPlan steps
  6. If Claude produces a plan → save as AIPlan with status 'proposed'
  7. Return plan + any read results to frontend
```

**Flow 2: Plan approval + execution**
```
User approves plan → orchestrator.executePlan(planId)
  1. Load AIPlan, verify status === 'approved'
  2. For each step in order:
     a. Set step status → 'executing'
     b. Execute the tool handler with real QBO client
     c. Log result to step.result
     d. Create AuditLog entry with aiDriven=true, approvalEvent=planId
     e. Set step status → 'completed' or 'failed'
     f. If step fails and it's critical → abort remaining steps
  3. Set plan status → 'completed' or 'failed'
  4. Stream progress to frontend via SSE
```

**Flow 3: Investigation**
```
User asks "why does X?" → orchestrator.investigate()
  1. Build investigation-focused system prompt
  2. Claude uses read tools autonomously (lookupCustomer, getTransactionChain, etc.)
  3. Claude synthesizes findings into an explanation
  4. No writes — investigation is read-only
  5. Offer to generate a support note from findings
```

**Flow 4: Support note generation**
```
User requests note → orchestrator.generateNote(sessionId)
  1. Gather all tool results and findings from the session
  2. Send to Claude with note-generation prompt
  3. Claude produces structured note (summary, evidence, recommendation)
  4. Return formatted note — frontend shows with copy button
```

**Orchestrator agentic loop (for read tools):**

When Claude needs to gather information, it may make multiple sequential tool calls. The orchestrator runs a loop:

```
while (response has tool_use blocks AND iteration < 10):
  for each tool_use in response:
    if tool.requiresConfirmation:
      → add to plan steps (don't execute)
    else:
      → execute tool handler
      → collect result
  feed tool results back to Claude as tool_result messages
  get next Claude response
```

This allows Claude to chain read operations (e.g., look up customer → find their invoices → trace payment chain) without user intervention, while still gating all writes behind confirmation.

**Max iterations:** 10 tool-use rounds per chat turn (prevents runaway loops).
**Max tokens:** 4096 per response (sufficient for plans and explanations).

### 5.6 Streaming via SSE

**Why SSE over WebSocket:** Unidirectional (server→client), simpler to implement, works through proxies, auto-reconnects. We only need server-to-client streaming for AI responses.

**Implementation:**

Backend — SSE endpoint:
```
GET /api/ai/stream/:sessionId
  - Sets headers: Content-Type: text/event-stream, Cache-Control: no-cache
  - Streams Claude response chunks as SSE events
  - Event types:
    - 'token': partial text content
    - 'tool_start': AI is calling a tool (name + input)
    - 'tool_result': tool execution result
    - 'plan_proposed': full plan object ready for review
    - 'step_executing': plan step started
    - 'step_completed': plan step finished
    - 'note_ready': support note generated
    - 'done': stream complete
    - 'error': error occurred
```

Frontend — SSE consumer:
```js
const source = new EventSource(`/api/ai/stream/${sessionId}`);
source.addEventListener('token', (e) => appendToMessage(e.data));
source.addEventListener('plan_proposed', (e) => showPlanReview(JSON.parse(e.data)));
source.addEventListener('step_completed', (e) => updateExecutionLog(JSON.parse(e.data)));
// ...
```

**Non-streaming fallback:** For short operations (note generation, simple lookups), the regular POST endpoints return complete responses. SSE is used for chat and plan execution where real-time feedback matters.

### 5.7 AI Command Center (frontend)

**Layout:**

```
┌───────────────────────────────────────────────────────────────────┐
│ AI Command Center                              [Session History ▼]│
├──────────────────────────────────┬────────────────────────────────┤
│ Conversation                     │ Context Panel                  │
│                                  │                                │
│ ┌──────────────────────────────┐ │ Company: Acme Canada Inc       │
│ │ 🤖 I found 3 invoices for   │ │ Realm: 1234567890              │
│ │ Maple Corp. Invoice #1042    │ │ Last checkpoint: Apr 8         │
│ │ shows $3,500 balance but     │ │ Entities: 1,247               │
│ │ Payment #2001 was applied    │ │                                │
│ │ to Invoice #1043 instead.    │ │ ─── Active Plan ────────────── │
│ │                              │ │                                │
│ │ Here's my proposed fix:      │ │ "Fix AR mismatch for Maple"    │
│ │                              │ │                                │
│ │ ┌── Plan: Fix AR Mismatch ─┐│ │ Step 1: Create credit memo     │
│ │ │ Step 1: Create credit     ││ │   ✅ Approved                  │
│ │ │   memo for $3,500 on      ││ │ Step 2: Apply payment to       │
│ │ │   Invoice #1043           ││ │   correct invoice              │
│ │ │ Step 2: Apply new payment ││ │   ✅ Approved                  │
│ │ │   of $3,500 to Invoice   ││ │ Step 3: Create checkpoint      │
│ │ │   #1042                   ││ │   ⏳ Pending                   │
│ │ │ Step 3: Create checkpoint ││ │                                │
│ │ │   "After AR fix"          ││ │ [Execute All ✓] [Reject ✗]    │
│ │ └──────────────────────────┘│ │                                │
│ │                              │ │ ─── Support Note ──────────── │
│ │ 👤 Looks good, approve all  │ │                                │
│ │                              │ │ (generated after execution)    │
│ │ 🤖 Executing plan...        │ │                                │
│ │ ✅ Step 1 complete           │ │                                │
│ │ ✅ Step 2 complete           │ │                                │
│ │ ✅ Step 3 complete           │ │                                │
│ │                              │ │                                │
│ │ Plan executed. Would you     │ │                                │
│ │ like me to generate a        │ │                                │
│ │ support note?                │ │                                │
│ └──────────────────────────────┘ │                                │
│                                  │                                │
│ ┌──────────────────────────────┐ │                                │
│ │ Type a message...        [⏎] │ │                                │
│ └──────────────────────────────┘ │                                │
├──────────────────────────────────┴────────────────────────────────┤
│ Quick actions: [Investigate...] [Run Issue Pack...] [Generate Note]│
└───────────────────────────────────────────────────────────────────┘
```

**Key interactions:**

1. **Chat input** — user types natural language, streamed response appears in conversation
2. **Plan review** — when AI proposes a plan, it renders inline with per-step approve/reject checkboxes and a bulk "Approve All" button
3. **Execution log** — approved plan steps execute with real-time status (spinner → checkmark/X)
4. **Support note** — rendered in context panel with "Copy to clipboard" and "Copy as Markdown" buttons
5. **Session history** — dropdown to resume previous sessions with full context
6. **Quick actions** — shortcut buttons for common workflows (opens pre-filled chat)

**Keyboard shortcuts:**
- `Enter` — send message
- `Shift+Enter` — newline
- `Ctrl+Enter` — approve all pending plan steps
- `Escape` — reject current plan

### 5.8 Support note generation (`ai-notes.js`)

**Three note formats:**

**1. Escalation note:**
```markdown
## Escalation Summary

**Issue:** AR balance mismatch for Maple Corp
**Severity:** Medium
**Affected entities:** Invoice #1042, Payment #2001, Invoice #1043

### Root cause
Payment #2001 ($3,500) was applied to Invoice #1043 instead of
Invoice #1042. This left Invoice #1042 with a $3,500 open balance
and Invoice #1043 overpaid by $3,500.

### Evidence
- Invoice #1042: Balance $3,500.00 (should be $0.00)
- Payment #2001: LinkedTxn points to Invoice #1043 (Id: 456)
- Invoice #1043: Balance -$3,500.00 (overpaid)

### Steps taken
1. Identified misapplied payment via transaction chain analysis
2. Verified payment amount matches invoice total
3. Confirmed no other payments exist for Invoice #1042

### Recommended resolution
Re-apply Payment #2001 to Invoice #1042, or create a correcting
credit memo on Invoice #1043 and a new payment on Invoice #1042.
```

**2. Internal note** — shorter, bullet-point format for team handoff.

**3. Customer-facing note** — plain language, no internal IDs, focuses on resolution.

**Generation flow:**
1. Collect all findings from the AI session (tool results, explanations)
2. Construct a note-generation prompt with the findings as context
3. Claude generates the note in the requested format
4. Return to frontend for display and copy

### 5.9 Audit integration

Every AI action flows through the existing AuditLog:

```js
// Read tool executed by AI
{
  userId, realmId,
  action: 'AI lookup: Customer "Maple Corp"',
  actionType: 'ai_executed',
  tool: 'lookupCustomer',
  inputParams: { name: 'Maple Corp' },
  outcome: 'success',
  aiDriven: true,
}

// Write tool executed after approval
{
  userId, realmId,
  action: 'AI created Invoice #1055 for $3,500 to Maple Corp',
  actionType: 'ai_executed',
  tool: 'createInvoice',
  inputParams: { customerRef: {...}, lines: [...] },
  outcome: 'success',
  aiDriven: true,
  approvalEvent: 'plan:673a1f2e...',  // AIPlan ObjectId
  afterState: { Invoice: { Id: '1055', ... } },
}
```

New `actionType` values to add to AuditLog enum:
- `ai_read` — AI read/search operation
- `ai_plan` — AI proposed a plan
- `ai_approve` — user approved a plan
- `ai_reject` — user rejected a plan

### 5.10 Error handling

**Claude API errors:**
- Rate limit (429) → retry with exponential backoff, surface "AI is busy" to user
- Overloaded (529) → same retry, suggest trying again later
- Invalid response → log, show "AI produced an unexpected response" with retry button
- Network timeout → retry once, then surface error

**Tool execution errors:**
- QBO API failure during plan execution → mark step as failed, pause execution, ask user whether to continue or abort remaining steps
- Partial plan execution → plan status = 'failed', completed steps are recorded, user can re-run remaining steps

**Session recovery:**
- If server restarts during plan execution → on startup, find plans with status 'executing' and mark as 'failed' (same pattern as existing stale job recovery in server.js)
- Frontend reconnects SSE on disconnect with exponential backoff

---

## 6. Sequencing

### Sprint 1 (Week 1): Foundation — Provider + Tools + Session Model

| # | Task | Type | Depends on |
|---|------|------|-----------|
| 1.1 | Install `@anthropic-ai/sdk`, add `ANTHROPIC_API_KEY` to config | Backend | — |
| 1.2 | Build `ai-provider.js` — chat(), stream(), model selection | Backend | 1.1 |
| 1.3 | Create `AISession` and `AIPlan` models | Backend | — |
| 1.4 | Build `ai-tools.js` — all 12 tool definitions with JSON schemas | Backend | — |
| 1.5 | Build read tool handlers (6): lookupCustomer, lookupInvoice, searchEntities, getEntityDetail, getTransactionChain, getChangeSummary | Backend | 1.4 |
| 1.6 | Build write tool handlers (6): createInvoice, applyPayment, createBill, applyBillPayment, runIssuePack, createCheckpoint | Backend | 1.4 |
| 1.7 | Add new actionType values to AuditLog enum | Backend | — |
| 1.8 | Unit test tool handlers against mock QBO responses | Testing | 1.5, 1.6 |

**Sprint 1 gate:** All tool contracts defined and handlers tested. Claude SDK connects and responds.

### Sprint 2 (Week 2): Orchestrator + Confirmed Execution

| # | Task | Type | Depends on |
|---|------|------|-----------|
| 2.1 | Build `ai-orchestrator.js` — system prompt construction with company context | Backend | 1.2, 1.4 |
| 2.2 | Build orchestrator agentic loop — read tool auto-execution, write tool → plan conversion | Backend | 2.1, 1.5 |
| 2.3 | Build plan lifecycle: propose → approve → execute → complete | Backend | 2.2, 1.6 |
| 2.4 | Build SSE streaming endpoint (`GET /api/ai/stream/:sessionId`) | Backend | 2.1 |
| 2.5 | Create AI routes: `POST /chat`, `POST /plan/:id/approve`, `POST /plan/:id/reject`, `POST /plan/:id/execute` | Backend | 2.3 |
| 2.6 | Create AI routes: `GET /sessions`, `GET /sessions/:id` | Backend | 1.3 |
| 2.7 | Add stale AI plan recovery to server.js startup | Backend | 2.3 |
| 2.8 | Integration test: NL request → plan proposed → approved → executed → audit logged | Testing | 2.5 |

**Sprint 2 gate:** Full chat → plan → approve → execute flow works end-to-end via API. AI reads execute automatically, writes require approval.

### Sprint 3 (Week 3): AI Command Center Frontend

| # | Task | Type | Depends on |
|---|------|------|-----------|
| 3.1 | Build `ChatPanel.jsx` — message input, conversation display, SSE streaming consumer | Frontend | 2.4 |
| 3.2 | Build `PlanReview.jsx` — plan display with per-step approve/reject and bulk actions | Frontend | 2.5 |
| 3.3 | Build `ExecutionLog.jsx` — real-time step execution status via SSE | Frontend | 2.4 |
| 3.4 | Build `AICommandCenter.jsx` — compose ChatPanel + PlanReview + ExecutionLog + context panel | Frontend | 3.1, 3.2, 3.3 |
| 3.5 | Build `SessionHistory.jsx` — list past sessions, resume capability | Frontend | 2.6 |
| 3.6 | Add `/ai` route to App.jsx and sidebar navigation | Frontend | 3.4 |
| 3.7 | Add AI status indicator to Dashboard (active session, recent notes) | Frontend | 3.4 |
| 3.8 | Keyboard shortcuts for plan approval (Ctrl+Enter), rejection (Escape) | Frontend | 3.2 |

**Sprint 3 gate:** Full AI Command Center functional. User can chat, review plans, approve/execute, see real-time progress.

### Sprint 4 (Week 4): Investigation + Notes + Polish

| # | Task | Type | Depends on |
|---|------|------|-----------|
| 4.1 | Build investigation flow in orchestrator (read-only, multi-step evidence gathering) | Backend | 2.2 |
| 4.2 | Build `ai-notes.js` — three note formats (escalation, internal, customer) | Backend | — |
| 4.3 | Create `POST /api/ai/investigate` and `POST /api/ai/generate-note` routes | Backend | 4.1, 4.2 |
| 4.4 | Build `SupportNote.jsx` — rendered note with copy-to-clipboard and format toggle | Frontend | 4.3 |
| 4.5 | Add quick action buttons to AI Command Center (Investigate, Run Issue Pack, Generate Note) | Frontend | 4.3 |
| 4.6 | Add "Ask AI" contextual buttons to Entity Explorer and Checkpoints diff view | Frontend | 3.4 |
| 4.7 | End-to-end testing: NL scenario → plan → execute → investigate result → generate note | Testing | All |
| 4.8 | agent-browser visual verification of AI Command Center | Testing | 3.4 |
| 4.9 | Performance testing: concurrent AI sessions, large conversation histories | Testing | 2.1 |
| 4.10 | Dashboard integration: recent AI sessions, note count, quick-launch | Frontend | 3.7 |

**Sprint 4 gate (Phase 3 exit):** Full exit criteria met.

---

## 7. Infrastructure requirements

### Anthropic API
- API key required: `ANTHROPIC_API_KEY` in `.env`
- Estimated usage: ~$5-15/day during active development/testing
- Model access: Claude Sonnet 4 (primary), Claude Opus 4 (optional for deep analysis)
- Rate limits: 4,000 RPM on Sonnet (more than sufficient for single-user internal tool)

### New environment variables

```env
# AI Provider
ANTHROPIC_API_KEY=sk-ant-...
AI_MODEL_FAST=claude-sonnet-4-6
AI_MODEL_DEEP=claude-opus-4-6
AI_MAX_TOKENS=4096
AI_MAX_TOOL_ROUNDS=10
```

### New npm packages

**Backend:**
- `@anthropic-ai/sdk` — Anthropic Claude API client

**Frontend:**
- None — SSE is native (`EventSource`), no additional packages needed

### MongoDB sizing
- `AISession` documents: ~5-20KB each (conversation history grows with messages)
- `AIPlan` documents: ~2-5KB each
- Recommend: TTL index on archived sessions older than 90 days
- Index: `{ userId: 1, createdAt: -1 }` on both collections

---

## 8. Risk register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude hallucinates entity IDs that don't exist | Plan execution fails or targets wrong entities | Tool handlers validate all entity references before execution. System prompt instructs "never fabricate IDs — always look up first." Orchestrator pre-validates plan step inputs before execution. |
| Claude produces plans with unsafe mutations | User trusts AI and approves harmful changes | All write steps require explicit approval. Plan review UI shows exactly what each step will do. No bulk "approve all" for plans with >5 write steps (force per-step review). |
| AI response latency makes chat feel slow | Bad UX, users abandon the feature | SSE streaming shows tokens as they arrive. Read tool results return quickly. Show "AI is thinking..." with elapsed timer. |
| Anthropic API outage | AI features completely unavailable | All non-AI features (explorer, checkpoints, issue packs) work independently. Show clear "AI unavailable" status, not a broken page. |
| Token costs grow unexpectedly | Budget concern | Track token usage per session. Log totals. Set configurable max tokens per session (default 100K). Warn user at 80% of limit. |
| Long conversation histories exceed context window | AI loses earlier context or errors | Implement sliding window: keep system prompt + last 20 messages + all tool results from current plan. Summarize older messages. |
| Concurrent plan execution on same company | Conflicting QBO writes | Only one active plan per user per company. Queue additional plans. Frontend shows "Plan executing — wait for completion." |
| SSE connection drops during plan execution | User loses visibility into execution progress | Plan execution continues server-side regardless of SSE connection. Frontend reconnects and fetches current plan status via REST fallback. |

---

## 9. Gate D — Phase 3 exit criteria

All of the following must be true:

- [ ] User can type a natural language request and receive an AI-generated execution plan
- [ ] Plan contains discrete steps, each mapping to exactly one tool contract
- [ ] Read tools (6) execute automatically during conversation without user confirmation
- [ ] Write tools (6) require explicit user approval before execution
- [ ] Plan approval UI allows per-step and bulk approve/reject
- [ ] Approved plans execute with real-time progress via SSE streaming
- [ ] Every AI action logged to AuditLog with `aiDriven: true`
- [ ] Plans logged with approval events linking to the approving user
- [ ] User can ask an investigation question and receive an evidence-based explanation
- [ ] AI references specific entity IDs, amounts, and field values in explanations
- [ ] User can generate a support note in 3 formats (escalation, internal, customer)
- [ ] Support notes are one-click copyable
- [ ] AI session history persists and sessions can be resumed
- [ ] AI Command Center page passes design review (agent-browser + professional-design)
- [ ] "Ask AI" contextual buttons work from Entity Explorer and Checkpoint diff view
- [ ] No regression in Phase 1-2 functionality
- [ ] Lint clean, build passes
- [ ] Anthropic API errors handled gracefully (retry, fallback, user notification)

---

## 10. Appendix: Example AI interactions

### A. Natural language scenario planning

**User:** "Create an AR discrepancy where a customer has two invoices and the payment gets applied to the wrong one"

**AI (reads):**
1. `lookupCustomer({ name: "Maple" })` → finds Maple Corp (Id: 42)
2. `searchEntities({ type: "Item", query: "Consulting" })` → finds Consulting Service (Id: 15)

**AI (proposes plan):**
```
Plan: Create AR mismatch for Maple Corp

Step 1: Create Invoice A — $5,000 to Maple Corp for Consulting Service [WRITE]
Step 2: Create Invoice B — $3,000 to Maple Corp for Consulting Service [WRITE]
Step 3: Apply Payment of $5,000 to Invoice B (intentionally wrong) [WRITE]
Step 4: Create checkpoint "After AR mismatch injection" [WRITE]

Expected result: Invoice A shows $5,000 open. Invoice B shows $2,000 credit.
Payment is linked to B instead of A.
```

**User:** approves all → executes → success

### B. Investigation

**User:** "Why does Maple Corp's balance show $8,000 when they only have one open invoice for $5,000?"

**AI (reads automatically):**
1. `lookupCustomer({ name: "Maple Corp" })` → Balance: $8,000
2. `searchEntities({ type: "Invoice", query: "Maple" })` → finds 3 invoices
3. `getEntityDetail({ type: "Invoice", id: "1042" })` → $5,000, Balance $5,000 (open)
4. `getEntityDetail({ type: "Invoice", id: "1043" })` → $3,000, Balance $3,000 (open)
5. `getTransactionChain({ entityType: "Invoice", entityId: "1043" })` → no payments linked

**AI (explains):**
> Maple Corp's $8,000 balance comes from two open invoices:
> - Invoice #1042: $5,000 (open, no payments)
> - Invoice #1043: $3,000 (open, no payments)
>
> Neither invoice has any linked payments. The $8,000 is the sum of both open balances.
> If you expected only one open invoice, check if Invoice #1043 should have been paid
> or if a payment was applied elsewhere.
>
> Would you like me to generate a support note from this finding?

### C. Support note generation

**User:** "Yes, generate an escalation note"

**AI generates:**
```
## Escalation Summary

**Issue:** Customer balance discrepancy — Maple Corp
**Affected customer:** Maple Corp (QBO Id: 42)
**Reported balance:** $8,000 | **Expected:** $5,000

### Finding
Two open invoices contribute to the $8,000 balance:
1. Invoice #1042 — $5,000.00 (dated 2025-03-15, no payments)
2. Invoice #1043 — $3,000.00 (dated 2025-03-20, no payments)

### Investigation steps taken
1. Queried customer balance: $8,000
2. Retrieved all invoices for Maple Corp: 3 found (1 paid, 2 open)
3. Verified neither open invoice has linked payments
4. Traced transaction chains for both invoices: no linked records

### Recommended next steps
- Verify whether Invoice #1043 is legitimate or should be voided
- If a payment was expected, check undeposited funds and bank feeds
  for a $3,000 payment that may not have been linked
```
