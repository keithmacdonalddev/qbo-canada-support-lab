const config = require('../config');
const aiProvider = require('./ai-provider');
const { toolDefinitions, toolHandlers, toolPermissions } = require('./ai-tools');
const AISession = require('../models/AISession');
const AIPlan = require('../models/AIPlan');
const CompanyProfile = require('../models/CompanyProfile');
const Connection = require('../models/Connection');
const User = require('../models/User');
const { createQBOClient } = require('./qbo-client');
const { createAuditEntry } = require('../middleware/auditLogger');

// Late-bound import to break circular dependency (routes → orchestrator → routes)
let emitSSE = () => {};
function bindSSE(fn) { emitSSE = fn; }

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the system prompt injected into every AI conversation.
 * @param {Object} companyProfile - CompanyProfile document
 * @param {Object} additionalContext - optional extra context to append
 * @returns {string}
 */
function buildSystemPrompt(companyProfile, additionalContext = {}) {
  const entityCounts = companyProfile.entityCounts
    ? JSON.stringify(companyProfile.entityCounts, null, 2)
    : 'unknown';

  const issuePacks =
    companyProfile.activeIssuePacks && companyProfile.activeIssuePacks.length > 0
      ? companyProfile.activeIssuePacks.join(', ')
      : 'none';

  const lastCheckpoint =
    additionalContext.lastCheckpoint
      ? `${additionalContext.lastCheckpoint.name} (${new Date(additionalContext.lastCheckpoint.date).toISOString()})`
      : 'none';

  let prompt = `You are the AI assistant for the QBO Canada Support Lab. You help support agents reproduce customer issues, investigate discrepancies, and generate support notes.

Context:
- Company: ${companyProfile.companyName || 'Unknown'} (Realm: ${companyProfile.realmId})
- Subscription: ${companyProfile.subscriptionTier || 'QBO Advanced Canada'}
- Entity counts: ${entityCounts}
- Active issue packs: ${issuePacks}
- Last checkpoint: ${lastCheckpoint}

Rules:
- All write operations require user confirmation before execution.
- You can freely read/search/inspect entities without confirmation.
- Always reference specific entity IDs and amounts in your explanations.
- When proposing a plan, break it into discrete numbered steps.
- Each step must map to exactly one tool call.
- Never fabricate entity IDs — always look them up first.
- When investigating, gather evidence before forming conclusions.
- Be concise but thorough in explanations.`;

  if (additionalContext.modeInstructions) {
    prompt += '\n\n' + additionalContext.modeInstructions;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Helper: human-readable tool call description
// ---------------------------------------------------------------------------

/**
 * Return a human-readable description of what a tool call will do.
 * @param {string} toolName
 * @param {Object} input
 * @returns {string}
 */
function describeToolCall(toolName, input) {
  switch (toolName) {
    case 'createInvoice': {
      const customer = input.customerRef?.name || input.customerRef?.value || 'unknown customer';
      const total = input.totalAmount || input.amount || '?';
      return `Create invoice for ${customer}: $${total}`;
    }
    case 'applyPayment': {
      const amount = input.amount || '?';
      const invoiceId = input.invoiceId || input.invoiceRef?.value || '?';
      return `Apply $${amount} payment to Invoice #${invoiceId}`;
    }
    case 'createCreditMemo': {
      const cust = input.customerRef?.name || input.customerRef?.value || 'unknown customer';
      const amt = input.amount || input.totalAmount || '?';
      return `Create credit memo for ${cust}: $${amt}`;
    }
    case 'createBill': {
      const vendor = input.vendorRef?.name || input.vendorRef?.value || 'unknown vendor';
      const billAmt = input.totalAmount || input.amount || '?';
      return `Create bill from ${vendor}: $${billAmt}`;
    }
    case 'createBillPayment': {
      const billId = input.billId || input.billRef?.value || '?';
      const payAmt = input.amount || '?';
      return `Pay $${payAmt} on Bill #${billId}`;
    }
    case 'createVendorCredit': {
      const vc = input.vendorRef?.name || input.vendorRef?.value || 'unknown vendor';
      const vcAmt = input.amount || input.totalAmount || '?';
      return `Create vendor credit from ${vc}: $${vcAmt}`;
    }
    case 'createEstimate': {
      const estCust = input.customerRef?.name || input.customerRef?.value || 'unknown customer';
      return `Create estimate for ${estCust}`;
    }
    case 'createCustomer':
      return `Create customer: ${input.displayName || input.name || 'unnamed'}`;
    case 'createVendor':
      return `Create vendor: ${input.displayName || input.name || 'unnamed'}`;
    case 'createItem':
      return `Create item: ${input.name || 'unnamed'}`;
    case 'updateEntity': {
      const entity = input.entityType || 'entity';
      const id = input.entityId || input.id || '?';
      return `Update ${entity} #${id}`;
    }
    default:
      return `Execute ${toolName} with params: ${JSON.stringify(input).slice(0, 120)}`;
  }
}

// ---------------------------------------------------------------------------
// Helper: convert session messages to Anthropic format
// ---------------------------------------------------------------------------

/**
 * Convert the AISession.messages array to Anthropic messages format.
 * System messages are excluded (they go in the system param).
 * Adjacent same-role messages are combined.
 * @param {Object} session - AISession document
 * @returns {Array} Anthropic-format messages array
 */
function convertSessionMessages(session) {
  const anthropicMessages = [];

  for (const msg of session.messages) {
    // Skip system messages — those are handled via the system param
    if (msg.role === 'system') continue;

    // Tool results are sent as user messages with tool_result content blocks
    if (msg.role === 'tool_result') {
      anthropicMessages.push({
        role: 'user',
        content: msg.content ? JSON.parse(msg.content) : [],
      });
      continue;
    }

    // For assistant messages that include tool calls, reconstruct content blocks
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const contentBlocks = [];
      if (msg.content) {
        contentBlocks.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        contentBlocks.push({
          type: 'tool_use',
          id: tc.toolUseId || `tool_${Date.now()}`,
          name: tc.toolName,
          input: tc.input || {},
        });
      }
      anthropicMessages.push({ role: 'assistant', content: contentBlocks });
      continue;
    }

    // Standard user or assistant text message
    const entry = { role: msg.role, content: msg.content || '' };

    // Combine adjacent same-role messages
    const last = anthropicMessages[anthropicMessages.length - 1];
    if (last && last.role === entry.role && typeof last.content === 'string' && typeof entry.content === 'string') {
      last.content += '\n' + entry.content;
    } else {
      anthropicMessages.push(entry);
    }
  }

  return anthropicMessages;
}

// ---------------------------------------------------------------------------
// Helper: extract text from Anthropic response content blocks
// ---------------------------------------------------------------------------

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Helper: load context needed by most orchestrator functions
// ---------------------------------------------------------------------------

/**
 * Load the Connection + QBOClient + CompanyProfile for a given user/realm.
 * @param {string} userId
 * @param {string} realmId
 * @returns {{ connection, qbo, companyProfile }}
 */
async function loadContext(userId, realmId) {
  const connection = await Connection.findOne({ userId, realmId, status: 'active' });
  if (!connection) {
    throw new Error(`No active QBO connection for user ${userId}, realm ${realmId}`);
  }

  const qbo = await createQBOClient(connection);

  const companyProfile = await CompanyProfile.findOne({ userId, realmId });
  if (!companyProfile) {
    throw new Error(`No company profile found for user ${userId}, realm ${realmId}`);
  }

  // Load user's personal API key (if any) for the AI provider
  const user = await User.findById(userId).select('+anthropicApiKey');
  const userApiKey = user?.anthropicApiKey || null;

  return { connection, qbo, companyProfile, userApiKey };
}

// ---------------------------------------------------------------------------
// 1. chat — main conversation entry point
// ---------------------------------------------------------------------------

/**
 * Main chat function. Handles the full AI lifecycle for a single turn.
 * @param {string} userId
 * @param {string} realmId
 * @param {string|null} sessionId - existing session ID, or null to create
 * @param {string} userMessage
 * @returns {{ session, response: string, plan: Object|null }}
 */
async function chat(userId, realmId, sessionId, userMessage) {
  // 1. Load or create session
  let session;
  if (sessionId) {
    session = await AISession.findOne({ _id: sessionId, userId, realmId });
    if (!session) throw new Error('AI session not found');
    if (session.status !== 'active') throw new Error('AI session is not active');
  } else {
    session = await AISession.create({
      userId,
      realmId,
      title: userMessage.slice(0, 80),
      status: 'active',
      mode: 'suggest',
      messages: [],
      model: config.ai.modelFast,
    });
  }

  // 2. Load company profile, connection, QBO client, user API key
  const { connection, qbo, companyProfile, userApiKey } = await loadContext(userId, realmId);

  // 3. Build system prompt
  const systemPrompt = buildSystemPrompt(companyProfile);

  // 4. Add user message to session
  session.messages.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date(),
  });

  // 5. Convert to Anthropic format
  const messages = convertSessionMessages(session);

  // 6. Run the agentic loop
  const { finalResponse, planSteps, totalUsage } = await agenticLoop(
    messages,
    systemPrompt,
    { qbo, userId, realmId, connection, userApiKey },
  );

  // 7. Save assistant response to session
  const assistantText = extractTextFromContent(finalResponse.content);
  const assistantToolCalls = Array.isArray(finalResponse.content)
    ? finalResponse.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ toolName: b.name, input: b.input, toolUseId: b.id }))
    : [];

  session.messages.push({
    role: 'assistant',
    content: assistantText,
    toolCalls: assistantToolCalls,
    timestamp: new Date(),
  });

  // 8. Update token usage
  session.tokenUsage.inputTokens += totalUsage.inputTokens;
  session.tokenUsage.outputTokens += totalUsage.outputTokens;

  await session.save();

  // 9. If plan steps were collected, create an AIPlan
  let plan = null;
  if (planSteps.length > 0) {
    plan = await AIPlan.create({
      sessionId: session._id,
      userId,
      realmId,
      status: 'proposed',
      description: assistantText.slice(0, 500) || 'AI-proposed execution plan',
      steps: planSteps,
    });

    session.plans.push(plan._id);
    await session.save();

    // Audit the plan proposal
    await createAuditEntry(userId, realmId, `AI plan proposed: ${plan.steps.length} steps`, {
      actionType: 'ai_plan',
      tool: 'ai-orchestrator',
      inputParams: { planId: plan._id.toString(), stepCount: plan.steps.length },
      outcome: 'success',
      aiDriven: true,
    });

    // Push plan to connected SSE clients
    emitSSE(session._id.toString(), 'plan_proposed', plan.toObject());
  }

  return {
    session,
    response: assistantText,
    plan,
  };
}

// ---------------------------------------------------------------------------
// 2. Agentic loop — tool use loop with plan accumulation
// ---------------------------------------------------------------------------

/**
 * Run the agentic tool-use loop.
 * @param {Array} messages - Anthropic messages (mutated in place)
 * @param {string} systemPrompt
 * @param {Object} context - { qbo, userId, realmId, connection }
 * @returns {{ finalResponse, planSteps, totalUsage }}
 */
async function agenticLoop(messages, systemPrompt, context) {
  const { qbo, userId, realmId, connection, userApiKey } = context;
  const maxRounds = config.ai.maxToolRounds || 10;
  const planSteps = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  const providerOpts = { system: systemPrompt, userApiKey };

  let iteration = 0;
  let response = await aiProvider.chat(messages, toolDefinitions, providerOpts);

  // Accumulate first response usage
  if (response.usage) {
    totalUsage.inputTokens += response.usage.input_tokens || 0;
    totalUsage.outputTokens += response.usage.output_tokens || 0;
  }

  while (response.stop_reason === 'tool_use' && iteration < maxRounds) {
    iteration++;

    // Extract tool_use blocks from response content
    const toolUseBlocks = Array.isArray(response.content)
      ? response.content.filter(b => b.type === 'tool_use')
      : [];

    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      const permission = toolPermissions[toolUse.name];

      if (permission === 'confirm') {
        // Don't execute — collect as plan steps
        planSteps.push({
          stepNumber: planSteps.length + 1,
          description: describeToolCall(toolUse.name, toolUse.input),
          toolName: toolUse.name,
          toolInput: toolUse.input,
          requiresConfirmation: true,
          status: 'pending',
        });

        // Return a synthetic result telling Claude the step was queued
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            queued: true,
            message: `Step added to execution plan for user approval: ${toolUse.name}`,
          }),
        });
      } else {
        // Auto-execute read tools
        const handler = toolHandlers[toolUse.name];
        let result;

        if (!handler) {
          result = { success: false, error: `Unknown tool: ${toolUse.name}` };
        } else {
          try {
            result = await handler(toolUse.input, { qbo, userId, realmId, connection });

            // Audit the read
            await createAuditEntry(userId, realmId, `AI lookup: ${toolUse.name}`, {
              actionType: 'ai_read',
              tool: toolUse.name,
              inputParams: toolUse.input,
              outcome: 'success',
              aiDriven: true,
            });
          } catch (err) {
            result = { success: false, error: err.message };

            // Audit the failed read
            await createAuditEntry(userId, realmId, `AI lookup failed: ${toolUse.name}`, {
              actionType: 'ai_read',
              tool: toolUse.name,
              inputParams: toolUse.input,
              outcome: 'failure',
              aiDriven: true,
              error: err.message,
            });
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Add assistant response + tool results to messages for next round
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    // Get next response from Claude
    response = await aiProvider.chat(messages, toolDefinitions, providerOpts);

    // Accumulate usage
    if (response.usage) {
      totalUsage.inputTokens += response.usage.input_tokens || 0;
      totalUsage.outputTokens += response.usage.output_tokens || 0;
    }
  }

  return { finalResponse: response, planSteps, totalUsage };
}

// ---------------------------------------------------------------------------
// 3. executePlan — run an approved plan
// ---------------------------------------------------------------------------

/**
 * Execute an approved (or partially approved) plan.
 * @param {string} planId
 * @param {string} userId
 * @returns {Object} Updated AIPlan document
 */
async function executePlan(planId, userId) {
  const plan = await AIPlan.findById(planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.userId.toString() !== userId.toString()) throw new Error('Unauthorized');
  if (!['approved', 'partially_approved'].includes(plan.status)) {
    throw new Error(`Plan status is "${plan.status}" — must be approved or partially_approved`);
  }

  // Load connection and QBO client
  const connection = await Connection.findOne({ userId, realmId: plan.realmId, status: 'active' });
  if (!connection) throw new Error('No active QBO connection');
  const qbo = await createQBOClient(connection);

  // Mark plan as executing
  plan.status = 'executing';
  await plan.save();

  let hasFailure = false;

  for (const step of plan.steps) {
    // Only execute approved steps
    if (step.status !== 'approved') continue;

    // If a previous step failed, skip remaining
    if (hasFailure) {
      step.status = 'skipped';
      continue;
    }

    // Mark step as executing and notify SSE clients
    step.status = 'executing';
    await plan.save();
    emitSSE(plan.sessionId.toString(), 'step_executing', {
      stepNumber: step.stepNumber,
      description: step.description,
      toolName: step.toolName,
      status: 'executing',
    });

    const handler = toolHandlers[step.toolName];
    if (!handler) {
      step.status = 'failed';
      step.error = `Unknown tool: ${step.toolName}`;
      hasFailure = true;

      await createAuditEntry(userId, plan.realmId, `AI execution failed: ${step.toolName}`, {
        actionType: 'ai_executed',
        tool: step.toolName,
        inputParams: step.toolInput,
        outcome: 'failure',
        aiDriven: true,
        approvalEvent: planId,
        error: step.error,
      });
      continue;
    }

    try {
      const result = await handler(step.toolInput, { qbo, userId, realmId: plan.realmId, connection });
      step.status = 'completed';
      step.result = result;
      step.executedAt = new Date();

      await createAuditEntry(userId, plan.realmId, `AI executed: ${step.toolName}`, {
        actionType: 'ai_executed',
        tool: step.toolName,
        inputParams: step.toolInput,
        outcome: 'success',
        aiDriven: true,
        approvalEvent: planId,
      });

      emitSSE(plan.sessionId.toString(), 'step_completed', {
        stepNumber: step.stepNumber,
        status: 'completed',
        result: step.result,
        executedAt: step.executedAt,
      });
    } catch (err) {
      step.status = 'failed';
      step.error = err.message;
      hasFailure = true;

      await createAuditEntry(userId, plan.realmId, `AI execution failed: ${step.toolName}`, {
        actionType: 'ai_executed',
        tool: step.toolName,
        inputParams: step.toolInput,
        outcome: 'failure',
        aiDriven: true,
        approvalEvent: planId,
        error: err.message,
      });

      emitSSE(plan.sessionId.toString(), 'step_completed', {
        stepNumber: step.stepNumber,
        status: 'failed',
        error: err.message,
      });
    }
  }

  // Determine final plan status based only on steps that were approved for execution.
  // Rejected and pending steps are intentional non-execution — they don't count as failures.
  const approvedSteps = plan.steps.filter(s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped');
  const anyFailed = approvedSteps.some(s => s.status === 'failed');
  plan.status = anyFailed ? 'failed' : 'completed';
  plan.completedAt = new Date();
  await plan.save();

  emitSSE(plan.sessionId.toString(), 'done', {
    planId: plan._id.toString(),
    status: plan.status,
  });

  return plan;
}

// ---------------------------------------------------------------------------
// 4. approvePlan — approve all or specific steps
// ---------------------------------------------------------------------------

/**
 * Approve a proposed plan (all steps or selectively).
 * @param {string} planId
 * @param {string} userId
 * @param {Array|null} stepApprovals - optional [{ stepNumber, approved: boolean }]
 * @returns {Object} Updated AIPlan document
 */
async function approvePlan(planId, userId, stepApprovals) {
  const plan = await AIPlan.findById(planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.userId.toString() !== userId.toString()) throw new Error('Unauthorized');
  if (plan.status !== 'proposed') {
    throw new Error(`Plan status is "${plan.status}" — can only approve proposed plans`);
  }

  if (stepApprovals && Array.isArray(stepApprovals) && stepApprovals.length > 0) {
    // Selective approval
    for (const approval of stepApprovals) {
      const step = plan.steps.find(s => s.stepNumber === approval.stepNumber);
      if (step) {
        step.status = approval.approved ? 'approved' : 'rejected';
      }
    }

    // Determine plan-level status
    const approved = plan.steps.filter(s => s.status === 'approved').length;
    const rejected = plan.steps.filter(s => s.status === 'rejected').length;
    const total = plan.steps.length;

    if (approved === total) {
      plan.status = 'approved';
    } else if (rejected === total) {
      plan.status = 'rejected';
    } else if (approved > 0) {
      plan.status = 'partially_approved';
    } else {
      plan.status = 'proposed'; // No action taken on any step
    }
  } else {
    // Approve all steps
    for (const step of plan.steps) {
      if (step.status === 'pending') {
        step.status = 'approved';
      }
    }
    plan.status = 'approved';
  }

  plan.approvedAt = new Date();
  plan.approvedBy = userId;
  await plan.save();

  // Audit the approval
  await createAuditEntry(userId, plan.realmId, `AI plan ${plan.status}: ${plan._id}`, {
    actionType: 'ai_approve',
    tool: 'ai-orchestrator',
    inputParams: {
      planId: plan._id.toString(),
      stepApprovals: stepApprovals || 'all',
    },
    outcome: 'success',
    aiDriven: true,
  });

  return plan;
}

// ---------------------------------------------------------------------------
// 5. rejectPlan — reject all pending steps
// ---------------------------------------------------------------------------

/**
 * Reject an entire proposed plan.
 * @param {string} planId
 * @param {string} userId
 * @returns {Object} Updated AIPlan document
 */
async function rejectPlan(planId, userId) {
  const plan = await AIPlan.findById(planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.userId.toString() !== userId.toString()) throw new Error('Unauthorized');
  if (!['proposed', 'partially_approved'].includes(plan.status)) {
    throw new Error(`Plan status is "${plan.status}" — can only reject proposed or partially_approved plans`);
  }

  // Reject all pending steps
  for (const step of plan.steps) {
    if (step.status === 'pending') {
      step.status = 'rejected';
    }
  }

  plan.status = 'rejected';
  await plan.save();

  // Audit the rejection
  await createAuditEntry(userId, plan.realmId, `AI plan rejected: ${plan._id}`, {
    actionType: 'ai_reject',
    tool: 'ai-orchestrator',
    inputParams: { planId: plan._id.toString() },
    outcome: 'success',
    aiDriven: true,
  });

  return plan;
}

// ---------------------------------------------------------------------------
// 6. investigate — read-only investigation mode
// ---------------------------------------------------------------------------

/**
 * Investigation mode: read-only analysis, no write tools allowed.
 * @param {string} userId
 * @param {string} realmId
 * @param {string|null} sessionId
 * @param {string} question
 * @returns {{ session, explanation: string }}
 */
async function investigate(userId, realmId, sessionId, question) {
  // Load or create session in investigate mode
  let session;
  if (sessionId) {
    session = await AISession.findOne({ _id: sessionId, userId, realmId });
    if (!session) throw new Error('AI session not found');
    if (session.status !== 'active') throw new Error('AI session is not active');
  } else {
    session = await AISession.create({
      userId,
      realmId,
      title: `Investigation: ${question.slice(0, 60)}`,
      status: 'active',
      mode: 'investigate',
      messages: [],
      model: config.ai.modelFast,
    });
  }

  // Load context
  const { connection, qbo, companyProfile, userApiKey } = await loadContext(userId, realmId);

  // Build investigation-focused system prompt
  const systemPrompt = buildSystemPrompt(companyProfile, {
    modeInstructions:
      'You are investigating a discrepancy. Gather evidence using read tools. Do NOT propose write operations. Synthesize findings into a clear explanation with specific entity references.',
  });

  // Add user question
  session.messages.push({
    role: 'user',
    content: question,
    timestamp: new Date(),
  });

  // Convert to Anthropic format
  const messages = convertSessionMessages(session);

  // Run agentic loop with write-tool blocking
  const maxRounds = config.ai.maxToolRounds || 10;
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  const providerOpts = { system: systemPrompt, userApiKey };

  let iteration = 0;
  let response = await aiProvider.chat(messages, toolDefinitions, providerOpts);

  if (response.usage) {
    totalUsage.inputTokens += response.usage.input_tokens || 0;
    totalUsage.outputTokens += response.usage.output_tokens || 0;
  }

  while (response.stop_reason === 'tool_use' && iteration < maxRounds) {
    iteration++;

    const toolUseBlocks = Array.isArray(response.content)
      ? response.content.filter(b => b.type === 'tool_use')
      : [];

    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      const permission = toolPermissions[toolUse.name];

      if (permission === 'confirm') {
        // Block write tools in investigation mode
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            success: false,
            error: 'Write operations not available in investigation mode',
          }),
        });
      } else {
        // Auto-execute read tools
        const handler = toolHandlers[toolUse.name];
        let result;

        if (!handler) {
          result = { success: false, error: `Unknown tool: ${toolUse.name}` };
        } else {
          try {
            result = await handler(toolUse.input, { qbo, userId, realmId, connection });

            await createAuditEntry(userId, realmId, `AI investigation lookup: ${toolUse.name}`, {
              actionType: 'ai_read',
              tool: toolUse.name,
              inputParams: toolUse.input,
              outcome: 'success',
              aiDriven: true,
            });
          } catch (err) {
            result = { success: false, error: err.message };

            await createAuditEntry(userId, realmId, `AI investigation lookup failed: ${toolUse.name}`, {
              actionType: 'ai_read',
              tool: toolUse.name,
              inputParams: toolUse.input,
              outcome: 'failure',
              aiDriven: true,
              error: err.message,
            });
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await aiProvider.chat(messages, toolDefinitions, providerOpts);

    if (response.usage) {
      totalUsage.inputTokens += response.usage.input_tokens || 0;
      totalUsage.outputTokens += response.usage.output_tokens || 0;
    }
  }

  // Save assistant response
  const explanation = extractTextFromContent(response.content);

  session.messages.push({
    role: 'assistant',
    content: explanation,
    timestamp: new Date(),
  });

  session.tokenUsage.inputTokens += totalUsage.inputTokens;
  session.tokenUsage.outputTokens += totalUsage.outputTokens;
  await session.save();

  return { session, explanation };
}

// ---------------------------------------------------------------------------
// 7. generateNote — produce a formatted support note from a session
// ---------------------------------------------------------------------------

/**
 * Generate a formatted support note from a session's conversation.
 * @param {string} sessionId
 * @param {string} format - 'escalation' | 'internal' | 'customer'
 * @returns {string} The generated note content
 */
async function generateNote(sessionId, format = 'internal') {
  const session = await AISession.findById(sessionId);
  if (!session) throw new Error('AI session not found');

  // Load user's API key
  const user = await User.findById(session.userId).select('+anthropicApiKey');
  const userApiKey = user?.anthropicApiKey || null;

  // Build a summary of all messages and tool results from the session
  const conversationSummary = session.messages
    .map(msg => {
      let text = `[${msg.role}]: ${msg.content || ''}`;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        text += '\nTool calls: ' + msg.toolCalls.map(tc =>
          `${tc.toolName}(${JSON.stringify(tc.input).slice(0, 200)}) => ${JSON.stringify(tc.result).slice(0, 200)}`
        ).join('; ');
      }
      return text;
    })
    .join('\n\n');

  const formatInstructions = {
    escalation:
      'Generate a formal escalation note suitable for Intuit support escalation. Include: Summary, Steps to Reproduce, Expected vs Actual Behavior, Entity References (IDs, amounts, dates), and Recommended Resolution. Use professional, precise language.',
    internal:
      'Generate an internal support note for team reference. Include: Issue Summary, Investigation Findings, Key Entities, and Next Steps. Be concise and focus on actionable information.',
    customer:
      'Generate a customer-facing note explaining the investigation findings. Use clear, non-technical language. Include: What was found, What it means, and Recommended next steps. Be reassuring and professional.',
  };

  const noteSystemPrompt = `You are a technical writer for QBO Canada support. ${formatInstructions[format] || formatInstructions.internal}

Based on the following AI investigation session, generate the note. Reference specific entity IDs, amounts, and dates from the conversation.`;

  const messages = [
    {
      role: 'user',
      content: `Generate a ${format} note from this session:\n\n${conversationSummary}`,
    },
  ];

  const response = await aiProvider.chat(messages, [], {
    system: noteSystemPrompt,
    maxTokens: config.ai.maxTokens,
    userApiKey,
  });

  const noteContent = extractTextFromContent(response.content);

  // Update session mode
  session.mode = 'generate_note';

  // Track token usage for note generation
  if (response.usage) {
    session.tokenUsage.inputTokens += response.usage.input_tokens || 0;
    session.tokenUsage.outputTokens += response.usage.output_tokens || 0;
  }
  await session.save();

  return noteContent;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  chat,
  executePlan,
  approvePlan,
  rejectPlan,
  investigate,
  generateNote,
  bindSSE,
};
