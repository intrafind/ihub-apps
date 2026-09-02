/**
 * RunStream — the SSE v2 producer side.
 *
 * One stream per subscription id (a chat, a workflow execution, an agent run).
 * `RunStreamEmitter.emit(type, data)` builds a validated envelope
 * `{ v: 2, seq, runId, ts, type, data }` (contracts/sseV2.js) with a
 * per-stream monotonic `seq` and hands it to the delivery layer
 * (`deliverEnvelope`, wired by server/sse.js: local client or cluster relay).
 *
 * Also here: the translation of internal workflow / agent bus events onto v2
 * (`translateInternalEvent`), the projection of ledger events onto v2 for
 * re-sync (`projectLedgerEvent`) and the checkpoint → interaction mapping the
 * workflow bridge and the workflow stream share.
 *
 * @module services/loop/RunStream
 */
import { SSE_V2_EVENTS, RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { parseSseV2EventData } from './contracts/sseV2.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'RunStream';

/** streamId → last seq, so reconnects on the same stream keep increasing. */
const seqByStream = new Map();
/** streamId → current run binding `{ runId, emitter }` (chat turns register themselves). */
const currentByStream = new Map();
let deliver = null;

/** Install the delivery function `(streamId, envelope) => boolean` (server/sse.js). */
export function setEnvelopeDelivery(fn) {
  deliver = typeof fn === 'function' ? fn : null;
}

export function nextSeq(streamId) {
  const next = (seqByStream.get(streamId) || 0) + 1;
  seqByStream.set(streamId, next);
  return next;
}

export function currentSeq(streamId) {
  return seqByStream.get(streamId) || 0;
}

/** Forget a stream's counter (tests / stream teardown). */
export function resetStream(streamId) {
  seqByStream.delete(streamId);
  currentByStream.delete(streamId);
}

/**
 * Build one v2 envelope. Validates `data` against the contract for `type`
 * (throws a ZodError on mismatch — a producer bug, never a runtime condition).
 */
export function buildEnvelope({ streamId, runId, type, data, seq }) {
  const parsed = parseSseV2EventData(type, data ?? {});
  return {
    v: 2,
    seq: Number.isInteger(seq) ? seq : nextSeq(streamId),
    runId: runId || streamId,
    ts: new Date().toISOString(),
    type,
    data: parsed
  };
}

/**
 * Emitter bound to one stream (and, optionally, one run). `emit()` returns the
 * envelope it delivered so callers can log or test it.
 */
export class RunStreamEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.streamId - subscription id the client connected with
   * @param {string} [opts.runId] - default run id for envelopes
   * @param {Function} [opts.deliver] - override delivery (tests)
   */
  constructor({ streamId, runId = null, deliver: deliverOverride } = {}) {
    if (!streamId) throw new Error('RunStreamEmitter requires a streamId');
    this.streamId = streamId;
    this.runId = runId;
    this._deliver = deliverOverride || null;
  }

  /** Bind (or rebind) the default run id. */
  bind(runId) {
    this.runId = runId;
    return this;
  }

  /**
   * @param {string} type - SSE v2 event type
   * @param {Object} data - payload (validated)
   * @param {Object} [opts]
   * @param {string} [opts.runId] - override the run id for this envelope
   * @returns {Object} the envelope
   */
  emit(type, data, opts = {}) {
    let envelope;
    try {
      envelope = buildEnvelope({
        streamId: this.streamId,
        runId: opts.runId || this.runId || this.streamId,
        type,
        data
      });
    } catch (err) {
      logger.error('Invalid SSE v2 payload — event dropped', {
        component: COMPONENT,
        streamId: this.streamId,
        type,
        error: err.message
      });
      return null;
    }
    const fn = this._deliver || deliver;
    if (fn) {
      try {
        fn(this.streamId, envelope);
      } catch (err) {
        logger.warn('SSE v2 delivery failed', {
          component: COMPONENT,
          streamId: this.streamId,
          type,
          error: err.message
        });
      }
    }
    return envelope;
  }
}

/** Register the emitter that currently produces a stream's run (chat turn in flight). */
export function bindStreamRun(streamId, runId, emitter) {
  currentByStream.set(streamId, { runId, emitter });
}

export function unbindStreamRun(streamId, runId) {
  const cur = currentByStream.get(streamId);
  if (cur && (!runId || cur.runId === runId)) currentByStream.delete(streamId);
}

/** The emitter of the run currently producing on `streamId`, or null. */
export function getStreamRun(streamId) {
  return currentByStream.get(streamId) || null;
}

/** Convenience: emitter for a stream, bound to the current run when one is in flight. */
export function streamEmitter(streamId, runId) {
  if (runId) return new RunStreamEmitter({ streamId, runId });
  const cur = currentByStream.get(streamId);
  return cur?.emitter || new RunStreamEmitter({ streamId });
}

/**
 * Tool-side progress on a chat stream (search started, page fetched, skill
 * activated …). Tools only know the chatId; the frame is attached to the run
 * currently producing on that stream. No-op without a chat.
 *
 * @param {string} chatId
 * @param {Object} progress - `{ phase, message?, data?, toolId?, callId?, step? }`
 */
export function emitToolProgress(chatId, progress) {
  if (!chatId || !progress?.phase) return null;
  return streamEmitter(chatId).emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
    phase: String(progress.phase),
    ...(progress.message !== undefined ? { message: String(progress.message) } : {}),
    ...(progress.data !== undefined ? { data: progress.data } : {}),
    ...(progress.toolId ? { toolId: String(progress.toolId) } : {}),
    ...(progress.callId ? { callId: String(progress.callId) } : {}),
    ...(Number.isInteger(progress.step) ? { step: progress.step } : {})
  });
}

// ── checkpoint → interaction ────────────────────────────────────────────────

const CHECKPOINT_KIND = { approval: 'approval', review: 'review', input: 'question' };

/**
 * Map a workflow `human` node checkpoint onto the interaction contract.
 * @param {Object} checkpoint - HumanNodeExecutor checkpoint
 * @param {Object} ctx - `{ runId, executionId, step?, chatId?, workflowName? }`
 */
export function checkpointToInteraction(checkpoint, ctx = {}) {
  const cp = checkpoint || {};
  const options = Array.isArray(cp.options)
    ? cp.options.map(o => ({
        value: String(o.value ?? o.label ?? ''),
        label: String(o.label ?? o.value ?? ''),
        ...(o.description ? { description: String(o.description) } : {}),
        ...(o.style ? { style: String(o.style) } : {})
      }))
    : undefined;
  const inputType =
    cp.type === 'input'
      ? cp.inputSchema
        ? 'form'
        : 'text'
      : options?.length
        ? 'single_select'
        : 'confirm';
  return {
    id: String(cp.id || `${ctx.executionId || ctx.runId}:${cp.nodeId || 'checkpoint'}`),
    runId: ctx.runId || ctx.executionId,
    step: Number.isInteger(ctx.step) ? ctx.step : 0,
    kind: CHECKPOINT_KIND[cp.type] || 'approval',
    origin: 'node',
    prompt: {
      message: String(cp.message || cp.title || 'Your input is required'),
      ...(cp.title ? { title: String(cp.title) } : {}),
      inputType,
      ...(options ? { options } : {}),
      inputSchema: cp.inputSchema ?? null,
      showData: Array.isArray(cp.showData) ? cp.showData : null,
      ...(cp.displayData ? { displayData: cp.displayData } : {}),
      allowSkip: false,
      allowOther: false
    },
    policy: {
      expiresAt: cp.expiresAt || null,
      timeoutMs: cp.timeout || null,
      onTimeout: 'fail',
      fallback: 'park'
    },
    status: 'pending',
    source: {
      nodeId: cp.nodeId,
      ...(cp.nodeName ? { nodeName: cp.nodeName } : {}),
      executionId: ctx.executionId,
      ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
      checkpointId: String(cp.id || '')
    },
    createdAt: cp.createdAt || new Date().toISOString()
  };
}

// ── internal bus → v2 ───────────────────────────────────────────────────────

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function stripEnvelopeKeys(eventData) {
  const { event: _e, chatId: _c, _parentRunId: _p, ...rest } = eventData;
  return rest;
}

/**
 * Translate one internal workflow / agent bus event (`actionTracker`
 * `fire-sse` payload) into zero or more `{ type, data, runId }` triples.
 * The caller wraps them in envelopes for its stream.
 *
 * @param {Object} eventData - `{ event, chatId, executionId?, ... }`
 * @returns {Array<{type:string, data:Object, runId:string}>}
 */
export function translateInternalEvent(eventData) {
  const type = eventData?.event;
  if (typeof type !== 'string') return [];
  const runId = eventData.executionId || eventData.chatId;
  const out = [];
  const push = (t, d) => out.push({ type: t, data: d, runId });

  switch (type) {
    case 'workflow.start':
      push(SSE_V2_EVENTS.RUN_STARTED, {
        kind: 'workflow',
        refs: pick(eventData, ['executionId', 'workflowId', 'startNodes'])
      });
      break;
    case 'workflow.iteration':
      push(SSE_V2_EVENTS.PROGRESS_NODE, {
        executionId: eventData.executionId,
        nodeId: eventData.nodeId || '__loop__',
        status: 'running',
        ...(Number.isInteger(eventData.iteration) ? { iteration: eventData.iteration } : {}),
        progress: { kind: 'iteration', ...pick(eventData, ['loopNodeId', 'maxIterations']) }
      });
      break;
    case 'workflow.node.start':
      push(SSE_V2_EVENTS.PROGRESS_NODE, {
        executionId: eventData.executionId,
        nodeId: String(eventData.nodeId),
        ...(eventData.nodeType ? { nodeType: eventData.nodeType } : {}),
        status: 'running'
      });
      break;
    case 'workflow.node.complete':
      push(SSE_V2_EVENTS.PROGRESS_NODE, {
        executionId: eventData.executionId,
        nodeId: String(eventData.nodeId),
        status: 'completed',
        ...(Number.isInteger(eventData.result?.iteration)
          ? { iteration: eventData.result.iteration }
          : {}),
        output: eventData.result
      });
      break;
    case 'workflow.node.error':
      push(SSE_V2_EVENTS.PROGRESS_NODE, {
        executionId: eventData.executionId,
        nodeId: String(eventData.nodeId),
        status: 'failed',
        error: String(eventData.error?.message || eventData.error || 'error')
      });
      break;
    case 'workflow.node.progress':
      push(SSE_V2_EVENTS.PROGRESS_NODE, {
        executionId: eventData.executionId,
        nodeId: String(eventData.nodeId || 'progress'),
        status: eventData.status || 'running',
        progress: { message: eventData.message }
      });
      break;
    case 'workflow.paused':
      push(SSE_V2_EVENTS.RUN_PAUSED, { reason: 'manual' });
      break;
    case 'workflow.human.required': {
      const interaction = checkpointToInteraction(eventData.checkpoint, {
        runId,
        executionId: eventData.executionId
      });
      push(SSE_V2_EVENTS.INTERACTION_RAISED, { interaction });
      push(SSE_V2_EVENTS.RUN_PAUSED, { reason: 'interaction', interactionId: interaction.id });
      break;
    }
    case 'workflow.human.responded': {
      const interactionId = String(
        eventData.checkpointId || eventData.checkpoint?.id || 'checkpoint'
      );
      push(SSE_V2_EVENTS.INTERACTION_ANSWERED, {
        interactionId,
        kind: CHECKPOINT_KIND[eventData.checkpoint?.type] || 'approval',
        answer: {
          value: eventData.response ?? eventData.answer?.value ?? null,
          ...(eventData.data ? { data: eventData.data } : {}),
          by: String(eventData.respondedBy || eventData.by || 'user'),
          at: new Date().toISOString(),
          channel: 'run_page'
        }
      });
      push(SSE_V2_EVENTS.RUN_RESUMED, { interactionId });
      break;
    }
    case 'workflow.complete':
      push(SSE_V2_EVENTS.RUN_ENDED, {
        status: normalizeEndStatus(eventData.status),
        finishReason:
          eventData.status && eventData.status !== 'completed' ? eventData.status : null,
        ...(eventData.output !== undefined ? { output: eventData.output } : {})
      });
      break;
    case 'workflow.failed':
      push(SSE_V2_EVENTS.RUN_ENDED, {
        status: 'error',
        finishReason: 'error',
        error: {
          message: String(eventData.error?.message || eventData.error || 'Workflow failed'),
          ...(eventData.error?.code ? { code: String(eventData.error.code) } : {})
        }
      });
      break;
    case 'workflow.cancelled':
      push(SSE_V2_EVENTS.RUN_ENDED, {
        status: 'aborted',
        finishReason: 'cancelled',
        ...(eventData.reason ? { error: { message: String(eventData.reason) } } : {})
      });
      break;
    case 'workflow.checkpoint.saved':
      push(SSE_V2_EVENTS.META, {
        executionId: eventData.executionId,
        extra: { checkpointSaved: true }
      });
      break;
    case 'workflow.plan.created':
      push(SSE_V2_EVENTS.META, {
        executionId: eventData.executionId,
        extra: { planCreated: eventData.plan ?? null }
      });
      break;
    case 'workflow.subworkflow.start':
    case 'workflow.subworkflow.complete': {
      const childId =
        eventData.data?.executionId || eventData.subExecutionId || eventData.executionId;
      push(SSE_V2_EVENTS.PROGRESS_NODE, {
        executionId: eventData.executionId,
        nodeId: `sub:${childId}`,
        nodeType: 'subworkflow',
        status: type.endsWith('.start') ? 'running' : 'completed',
        progress: {
          executionId: childId,
          ...pick(eventData.data || eventData, ['depth', 'taskCount', 'status'])
        }
      });
      break;
    }
    default:
      if (type.startsWith('agent.')) {
        push(SSE_V2_EVENTS.TOOL_PROGRESS, {
          phase: type,
          ...(typeof eventData.message === 'string' ? { message: eventData.message } : {}),
          data: stripEnvelopeKeys(eventData)
        });
      }
  }
  return out;
}

function normalizeEndStatus(status) {
  if (!status || status === 'completed') return 'completed';
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'cancelled' || status === 'aborted') return 'aborted';
  // custom terminal statuses of decision workflows (approved / rejected …)
  return 'completed';
}

// ── ledger → v2 (re-sync) ───────────────────────────────────────────────────

/**
 * Project one ledger event onto v2 envelopes (same `seq` as the ledger event
 * so a client can splice them into its per-run sequence).
 * @param {Object} ev - `{ seq, ts, runId, type, data }`
 * @returns {Array<Object>} envelopes
 */
export function projectLedgerEvent(ev) {
  if (!ev || typeof ev !== 'object') return [];
  const wrap = (type, data) => ({
    v: 2,
    seq: ev.seq,
    runId: ev.runId,
    ts: ev.ts,
    type,
    data: parseSseV2EventData(type, data)
  });
  const d = ev.data || {};
  switch (ev.type) {
    case RUN_LOG_EVENTS.RUN_START:
      return [
        wrap(SSE_V2_EVENTS.RUN_STARTED, {
          kind: d.kind || 'chat',
          ...(d.parentRunId ? { parentRunId: d.parentRunId } : {}),
          ...(d.model ? { model: typeof d.model === 'string' ? d.model : d.model.id } : {}),
          refs: d.refs || {}
        })
      ];
    case RUN_LOG_EVENTS.RUN_END:
      return [
        wrap(SSE_V2_EVENTS.RUN_ENDED, {
          status: d.status || 'completed',
          finishReason: d.finishReason ?? null,
          ...(d.usage ? { usage: d.usage } : {}),
          ...(d.error ? { error: d.error } : {})
        })
      ];
    case RUN_LOG_EVENTS.RUN_PAUSED:
      return [
        wrap(SSE_V2_EVENTS.RUN_PAUSED, {
          reason: d.reason || 'interaction',
          interactionId: d.interactionId
        })
      ];
    case RUN_LOG_EVENTS.RUN_RESUMED:
      return [wrap(SSE_V2_EVENTS.RUN_RESUMED, { interactionId: d.interactionId })];
    case RUN_LOG_EVENTS.MESSAGE_ASSISTANT:
      return [
        wrap(SSE_V2_EVENTS.STEP_COMPLETED, {
          step: d.step ?? 0,
          content: d.content || '',
          toolCalls: d.toolCalls || [],
          finishReason: d.finishReason ?? null,
          ...(d.usage ? { usage: d.usage } : {}),
          ...(d.groundingMetadata ? { groundingMetadata: d.groundingMetadata } : {})
        })
      ];
    case RUN_LOG_EVENTS.TOOL_CALL:
      return [
        wrap(SSE_V2_EVENTS.TOOL_STARTED, {
          step: d.step ?? 0,
          callId: String(d.callId),
          toolId: String(d.toolId),
          name: String(d.name || d.toolId),
          args: d.args,
          execution: d.execution || 'server'
        })
      ];
    case RUN_LOG_EVENTS.TOOL_RESULT:
      return [
        wrap(SSE_V2_EVENTS.TOOL_COMPLETED, {
          step: d.step ?? 0,
          callId: String(d.callId),
          toolId: String(d.toolId),
          name: String(d.name || d.toolId),
          resultPreview: d.resultPreview ?? null,
          ...(d.error ? { error: { message: String(d.error.message || 'error') } } : {}),
          ...(Number.isInteger(d.durationMs) ? { durationMs: d.durationMs } : {}),
          ...(d.knowledgeSource ? { knowledgeSource: d.knowledgeSource } : {})
        })
      ];
    case RUN_LOG_EVENTS.INTERACTION_RAISED:
      return d.interaction
        ? [wrap(SSE_V2_EVENTS.INTERACTION_RAISED, { interaction: d.interaction })]
        : [];
    case RUN_LOG_EVENTS.INTERACTION_ANSWERED:
      return d.interactionId && d.answer
        ? [
            wrap(SSE_V2_EVENTS.INTERACTION_ANSWERED, {
              interactionId: d.interactionId,
              kind: d.kind || 'question',
              answer: d.answer
            })
          ]
        : [];
    case RUN_LOG_EVENTS.ERROR:
      return [
        wrap(SSE_V2_EVENTS.STREAM_ERROR, {
          code: String(d.code || 'ERROR'),
          message: String(d.message || 'error'),
          retryable: d.recoverable === true
        })
      ];
    default:
      return [];
  }
}
