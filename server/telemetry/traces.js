// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The spans of iHub's units of work, built on `spans.js`, so names and
 * attributes are the same wherever a unit starts:
 *
 * | Unit                         | Span name                     | Kind     |
 * | ---------------------------- | ----------------------------- | -------- |
 * | Chat turn / app run          | `invoke_agent {app.id}`       | INTERNAL |
 * | Inference API request        | `inference {api}`             | INTERNAL |
 * | MCP server tool call         | `tools/call {tool}`           | SERVER   |
 * | A2A task                     | `a2a.task {skill kind}`       | INTERNAL |
 * | Tool call in the agent loop  | `execute_tool {tool}`         | INTERNAL |
 * | Workflow run (one segment)   | `workflow.run`                | INTERNAL |
 * | Workflow node                | `workflow.node {node.type}`   | INTERNAL |
 * | Scheduled task run           | `scheduled_task.run`          | INTERNAL |
 * | Retrieval                    | `retrieval {source.provider}` | CLIENT   |
 * | Text extraction              | `extraction {format}`         | INTERNAL |
 *
 * The LLM call (`{operation} {model}`, `GenAIInstrumentation.js`) becomes a
 * child of whichever of these is active.
 *
 * Names hold at most one bounded value: an app id or node type from config, a
 * configured tool id. A tool an MCP server or an A2A agent reports at runtime
 * is named by its kind (`execute_tool mcp`), its own name goes on the span as
 * `gen_ai.tool.name`. No arguments, queries or results go on any span: only
 * counts and sizes.
 *
 * @module telemetry/traces
 */

import { context as otelContext, createContextKey } from '@opentelemetry/api';
import { conversationSpanAttributes, userSpanAttributes } from './identity.js';
import {
  recordHitlWait,
  recordToolDuration,
  recordTurn,
  recordWorkflowExecution,
  recordWorkflowNode
} from './metrics.js';
import { linksFrom, SpanKind, startSpan, withSpan } from './spans.js';

/** Context key of the running turn's state, which its tool calls report to. */
const TURN_STATE = createContextKey('ihub.turn.state');

/** Trigger types of a turn; anything else is `other`. */
const TRIGGERS = new Set(['user', 'schedule', 'system', 'workflow', 'api', 'mcp', 'a2a', 'agent']);

/** Normalise a free value to one of `allowed`, else `other`. */
function bounded(value, allowed, fallback = 'other') {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

/** A name segment from config: safe characters only, cut to 64. */
function nameSegment(value, fallback = 'unknown') {
  if (typeof value !== 'string' || value === '') return fallback;
  return value.replace(/[^\w.:/-]/g, '_').slice(0, 64);
}

/**
 * Start the span of a chat turn or app run (`invoke_agent {app.id}`). The
 * caller makes it active (`span.run`) and ends it.
 *
 * @param {Object} turn
 * @param {string} [turn.appId]
 * @param {string} [turn.modelId]
 * @param {string} [turn.chatId] - Hashed by `identity.js`
 * @param {string} [turn.userId] - Pseudonymised by `identity.js`
 * @param {string} [turn.trigger] - `user`, `schedule`, `api`, … (closed set)
 * @param {boolean} [turn.streaming]
 * @param {string} [turn.kind] - `turn` (a chat turn) or `subagent` (an app called as a tool)
 * @param {string} [turn.surface] - `chat`, `agent`, `task`, `api`, … (metric label)
 * @param {string} [turn.channel] - `web`, `office`, `mcp`, … (`channel.js`, metric label)
 * @returns {import('./spans.js').SpanHandle}
 */
export function startTurnSpan({
  appId,
  modelId,
  chatId,
  userId,
  trigger,
  streaming,
  kind = 'turn',
  surface,
  channel,
  metrics = true
}) {
  const span = startSpan(`invoke_agent ${nameSegment(appId, 'chat')}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      ...(appId ? { 'app.id': appId, 'gen_ai.agent.id': appId } : {}),
      ...(modelId ? { 'gen_ai.request.model': modelId } : {}),
      'ihub.turn.kind': kind === 'subagent' ? 'subagent' : 'turn',
      'ihub.trigger.type': bounded(trigger ?? 'user', TRIGGERS),
      ...(typeof streaming === 'boolean' ? { 'ihub.streaming': streaming } : {}),
      ...(surface ? { 'ihub.surface': surface } : {}),
      ...(channel ? { 'ihub.client.channel': channel } : {}),
      ...conversationSpanAttributes(chatId),
      ...userSpanAttributes(userId)
    }
  });
  // What the turn's metrics need at its end, and what its tool calls report to.
  span.turn = { appId, surface, channel, metrics, startedAt: Date.now(), toolFailures: 0 };
  span.context = span.context.setValue(TURN_STATE, span.turn);
  return span;
}

/**
 * Record how a turn ended on its span. `status` is the turn result's status
 * (`completed`, `paused`, `aborted`, `error`, …).
 *
 * @param {import('./spans.js').SpanHandle} span
 * @param {Object} [result] - The turn result
 */
export function endTurnSpan(span, result) {
  const status = typeof result?.status === 'string' ? result.status.slice(0, 32) : 'unknown';
  const outcome = turnOutcomeOf(result, span.turn);
  span.setAttributes({ 'ihub.turn.status': status, 'ihub.turn.outcome': outcome });
  if (status === 'aborted') span.abort();
  else if (status === 'error') span.fail({ code: result?.errorInfo?.code || 'TURN_FAILED' });
  // An app run as another app's tool is part of that turn: its span, not a turn of its own.
  if (span.turn && span.turn.metrics !== false) {
    recordTurn({
      seconds: (Date.now() - span.turn.startedAt) / 1000,
      outcome,
      surface: span.turn.surface,
      channel: span.turn.channel,
      appId: span.turn.appId
    });
  }
}

/** Error codes of a failed turn that mean "over the user's limit" / "provider busy". */
const QUOTA_CODES = new Set(['QUOTA_EXCEEDED']);
const RATE_CODES = new Set(['RATE_LIMITED', 'rate_limit_exceeded']);

/**
 * How a turn ended for the user: `ok`, `error`, `quota`, `rate_limited`,
 * `aborted`, `empty` (it ended without an answer, a question or a tool result
 * to show) or `tool_degraded` (it answered, but at least one tool call failed).
 *
 * @param {Object} result - The turn result
 * @param {{toolFailures?: number}} [turn]
 * @returns {string}
 */
export function turnOutcomeOf(result, turn) {
  const status = result?.status;
  if (status === 'aborted') return 'aborted';
  if (status === 'error') {
    const code = result?.errorInfo?.code || result?.error?.code;
    if (QUOTA_CODES.has(code)) return 'quota';
    if (RATE_CODES.has(code)) return 'rate_limited';
    return 'error';
  }
  const content = result?.content ?? result?.finalMessage?.content;
  const answered =
    (typeof content === 'string' && content.trim() !== '') ||
    Boolean(result?.pendingInteraction || result?.toolName || result?.structuredOutput);
  if (!answered && status !== 'paused') return 'empty';
  return turn?.toolFailures > 0 ? 'tool_degraded' : 'ok';
}

/**
 * The bounded name of a tool for a span name: a configured tool id, or the
 * kind of tool a remote system reports at runtime.
 *
 * @param {Object|null|undefined} toolDef
 * @param {string} toolId
 * @returns {string}
 */
export function toolSpanName(toolDef, toolId) {
  if (!toolDef) return 'unknown';
  if (toolDef._mcp) return 'mcp';
  if (toolDef._a2a) return 'a2a';
  return nameSegment(toolId);
}

/**
 * Start the span of one tool call (`execute_tool {tool}`).
 *
 * @param {Object} call
 * @param {Object|null} call.toolDef
 * @param {string} call.toolId
 * @param {string} [call.callId] - The model's tool call id
 * @param {string} [call.origin] - `activityOrigin` (`web`, `project`, …)
 * @returns {import('./spans.js').SpanHandle}
 */
export function startToolSpan({ toolDef, toolId, callId, origin }) {
  const name = toolSpanName(toolDef, toolId);
  const span = startSpan(`execute_tool ${name}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': toolId,
      ...(callId ? { 'gen_ai.tool.call.id': callId } : {}),
      'tool.origin': origin || 'none'
    }
  });
  span.tool = { name, origin, startedAt: Date.now() };
  return span;
}

/**
 * Record what a tool call came to: origin, outcome, result count and size.
 *
 * @param {import('./spans.js').SpanHandle} span
 * @param {Object} result
 * @param {string} [result.origin]
 * @param {'results'|'empty'|'error'|'unknown'} [result.outcome]
 * @param {number} [result.count]
 * @param {number} [result.bytes]
 * @param {boolean} [result.failed]
 * @param {boolean} [result.rateLimited]
 */
export function endToolSpan(span, { origin, outcome, count, bytes, failed, rateLimited } = {}) {
  span.setAttributes({
    ...(origin ? { 'tool.origin': origin } : {}),
    ...(outcome ? { 'tool.outcome': outcome } : {}),
    ...(Number.isInteger(count) ? { 'ihub.result.count': count } : {}),
    ...(Number.isFinite(bytes) ? { 'ihub.result.bytes': bytes } : {})
  });
  if (rateLimited) span.fail({ code: 'TOOL_RATE_LIMITED' });
  else if (failed) span.fail({ code: 'TOOL_FAILED' });
  if (span.tool) {
    recordToolDuration({
      seconds: (Date.now() - span.tool.startedAt) / 1000,
      toolName: span.tool.name,
      origin: origin || span.tool.origin,
      outcome: failed || rateLimited ? 'error' : outcome
    });
  }
  if (failed || rateLimited) {
    // The turn answered with a tool that failed: `tool_degraded`.
    const turn = otelContext.active().getValue(TURN_STATE);
    if (turn) turn.toolFailures += 1;
  }
}

/** In-process trace carriers of workflow runs, for the link when one resumes. */
const workflowCarriers = new Map();
/** When a workflow paused for a human, for `ihub.hitl.wait.duration` when it resumes. */
const workflowPausedAt = new Map();
const MAX_WORKFLOW_CARRIERS = 5000;

/**
 * Start the span of one segment of a workflow run (`workflow.run`). A run that
 * resumes (after a human decision, a restart, a checkpoint) starts a new trace
 * linked to the segment before it, instead of becoming a child of the request
 * that answered.
 *
 * @param {Object} run
 * @param {string} run.executionId
 * @param {string} [run.workflowId]
 * @param {string} [run.userId]
 * @param {boolean} [run.resumed]
 * @param {number} [run.depth] - Sub-workflow depth
 * @returns {import('./spans.js').SpanHandle}
 */
export function startWorkflowRunSpan({ executionId, workflowId, userId, resumed = false, depth }) {
  const span = startSpan('workflow.run', {
    kind: SpanKind.INTERNAL,
    ...(resumed ? { root: true, links: linksFrom(workflowCarriers.get(executionId)) } : {}),
    attributes: {
      ...(workflowId ? { 'ihub.workflow.id': workflowId } : {}),
      'ihub.workflow.execution_id': executionId,
      'ihub.workflow.resumed': resumed,
      ...(Number.isInteger(depth) ? { 'ihub.workflow.depth': depth } : {}),
      ...userSpanAttributes(userId)
    }
  });
  rememberWorkflowCarrier(executionId, span);
  if (resumed && workflowPausedAt.has(executionId)) {
    recordHitlWait((Date.now() - workflowPausedAt.get(executionId)) / 1000);
  }
  workflowPausedAt.delete(executionId);
  span.workflow = { startedAt: Date.now() };
  return span;
}

function rememberWorkflowCarrier(executionId, span) {
  const { traceId, spanId, traceFlags } = span.spanContext;
  if (!traceId || /^0+$/.test(traceId)) return;
  workflowCarriers.delete(executionId);
  workflowCarriers.set(executionId, {
    traceparent: `00-${traceId}-${spanId}-${(traceFlags ?? 1).toString(16).padStart(2, '0')}`
  });
  if (workflowCarriers.size > MAX_WORKFLOW_CARRIERS) {
    workflowCarriers.delete(workflowCarriers.keys().next().value);
  }
}

/**
 * Record how a workflow segment ended.
 *
 * @param {import('./spans.js').SpanHandle} span
 * @param {string} status - `completed`, `paused`, `failed`, `cancelled`, …
 * @param {string} executionId
 */
export function endWorkflowRunSpan(span, status, executionId) {
  span.setAttributes({ 'ihub.workflow.status': String(status || 'unknown').slice(0, 32) });
  // Failed and cancelled runs can be resumed (WorkflowEngine.resumeFromTerminated),
  // so their carrier stays for the link; MAX_WORKFLOW_CARRIERS bounds the map.
  if (status === 'completed') workflowCarriers.delete(executionId);
  if (status === 'paused') {
    workflowPausedAt.set(executionId, Date.now());
    if (workflowPausedAt.size > MAX_WORKFLOW_CARRIERS) {
      workflowPausedAt.delete(workflowPausedAt.keys().next().value);
    }
  }
  if (span.workflow) {
    recordWorkflowExecution(status, (Date.now() - span.workflow.startedAt) / 1000);
  }
  if (status === 'cancelled') span.abort();
}

/**
 * Run one workflow node inside `workflow.node {node.type}`.
 *
 * @template T
 * @param {Object} node
 * @param {string} node.type - From the node registry (bounded)
 * @param {string} [node.id]
 * @param {number} [node.attempt] - Retry attempt, 0 for the first
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withWorkflowNodeSpan({ type, id, attempt }, fn) {
  const startedAt = Date.now();
  const settle = ok => recordWorkflowNode(type, (Date.now() - startedAt) / 1000, ok);
  return withSpan(
    `workflow.node ${nameSegment(type)}`,
    {
      attributes: {
        'ihub.workflow.node.type': type,
        ...(id ? { 'ihub.workflow.node.id': id } : {}),
        ...(Number.isInteger(attempt) ? { 'ihub.retry.attempt': attempt } : {})
      }
    },
    fn
  ).then(
    result => {
      settle(true);
      return result;
    },
    error => {
      settle(false);
      throw error;
    }
  );
}

/**
 * Run a scheduled task run inside its own trace (`scheduled_task.run`).
 *
 * @template T
 * @param {Object} run
 * @param {string} [run.appId]
 * @param {string} [run.userId]
 * @param {string} [run.trigger] - `schedule`, `manual`, `catch_up`, …
 * @param {(span: import('./spans.js').SpanHandle) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withScheduledTaskSpan({ appId, userId, trigger }, fn) {
  return withSpan(
    'scheduled_task.run',
    {
      root: true,
      attributes: {
        ...(appId ? { 'app.id': appId } : {}),
        'ihub.trigger.type': typeof trigger === 'string' ? trigger.slice(0, 32) : 'schedule',
        ...userSpanAttributes(userId)
      }
    },
    fn
  );
}

/**
 * Run a retrieval call (`retrieval {provider}`, CLIENT). `fn` returns the
 * result; `countOf(result)` says how many hits it has.
 *
 * @template T
 * @param {string} provider - `project`, `ifinder`, `iassistant`, …
 * @param {() => Promise<T>} fn
 * @param {(result: T) => number|undefined} [countOf]
 * @returns {Promise<T>}
 */
export function withRetrievalSpan(provider, fn, countOf) {
  return withSpan(
    `retrieval ${nameSegment(provider)}`,
    { kind: SpanKind.CLIENT, attributes: { 'source.provider': provider } },
    async span => {
      const result = await fn();
      const count = countOf ? countOf(result) : undefined;
      if (Number.isInteger(count)) span.setAttributes({ 'ihub.result.count': count });
      return result;
    }
  );
}

/**
 * Run a text extraction (`extraction {format}`). The format is known up front
 * from the content type when possible and corrected from the result.
 *
 * @template T
 * @param {Object} input
 * @param {string} [input.format] - Expected format (`pdf`, `docx`, …)
 * @param {number} [input.bytes] - Input size
 * @param {boolean} [input.thread] - Runs in an extraction thread
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withExtractionSpan({ format, bytes, thread }, fn) {
  return withSpan(
    `extraction ${nameSegment(format)}`,
    {
      attributes: {
        'ihub.extraction.format': format || 'unknown',
        ...(Number.isFinite(bytes) ? { 'ihub.input.bytes': bytes } : {}),
        ...(typeof thread === 'boolean' ? { 'ihub.extraction.thread': thread } : {})
      }
    },
    fn
  );
}

/** The inference APIs. */
const INFERENCE_APIS = new Set(['chat_completions', 'responses']);

/**
 * Run one inference API request (`inference {api}`). With `autoInstrumentation`
 * the HTTP server span is its parent; the app turn or the model call below it
 * are its children.
 *
 * @template T
 * @param {Object} request
 * @param {'chat_completions'|'responses'} request.api
 * @param {'app'|'model'} [request.target] - What the request names
 * @param {boolean} [request.stream]
 * @param {string} [request.userId]
 * @param {(span: import('./spans.js').SpanHandle) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withInferenceSpan({ api, target, stream, userId }, fn) {
  const name = bounded(api, INFERENCE_APIS, 'unknown');
  return withSpan(
    `inference ${name}`,
    {
      attributes: {
        'ihub.inference.api': name,
        ...(target ? { 'ihub.inference.target': target === 'app' ? 'app' : 'model' } : {}),
        ...(typeof stream === 'boolean' ? { 'ihub.streaming': stream } : {}),
        ...userSpanAttributes(userId)
      }
    },
    fn
  );
}

/**
 * Run one tool call the MCP server answers (`tools/call {tool}`, SERVER). The
 * tool names are the gateway's own: configured tools, apps and workflows.
 *
 * @template T
 * @param {Object} call
 * @param {string} call.tool
 * @param {string} [call.userId]
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withMcpToolSpan({ tool, userId }, fn) {
  return withSpan(
    `tools/call ${nameSegment(tool)}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': tool,
        ...userSpanAttributes(userId)
      }
    },
    fn
  );
}

/**
 * Run one A2A task (`a2a.task {kind}`): an app or a workflow answering an
 * agent.
 *
 * @template T
 * @param {Object} task
 * @param {'app'|'workflow'|string} task.skillKind
 * @param {string} [task.skillId] - App or workflow id from config
 * @param {boolean} [task.stream]
 * @param {string} [task.userId]
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withA2aTaskSpan({ skillKind, skillId, stream, userId }, fn) {
  const kind = skillKind === 'app' || skillKind === 'workflow' ? skillKind : 'other';
  return withSpan(
    `a2a.task ${kind}`,
    {
      attributes: {
        'ihub.a2a.skill.kind': kind,
        ...(skillId ? { 'ihub.a2a.skill.id': skillId } : {}),
        ...(typeof stream === 'boolean' ? { 'ihub.streaming': stream } : {}),
        ...userSpanAttributes(userId)
      }
    },
    fn
  );
}

/** Forget remembered workflow carriers (tests only). */
export function resetTracesForTests() {
  workflowCarriers.clear();
  workflowPausedAt.clear();
}
