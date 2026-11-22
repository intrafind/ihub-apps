// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * RunStream — the SSE v2 producer side.
 *
 * One stream per subscription id (a chat, a workflow execution, an agent run).
 * `RunStreamEmitter.emit(type, data)` builds a validated envelope
 * `{ v: 2, seq, runId, ts, type, data }` (contracts/sseV2.js) and hands it to
 * the delivery layer (wired by server/sse.js: local client or cluster relay).
 * The per-stream monotonic `seq` is assigned by the worker that delivers the
 * stream (`deliverEnvelope` stamps `nextSeq(streamId)`), not by the producer:
 * frames of one stream are produced on several workers (the SSE owner emits
 * `stream/connected`, the worker running the turn relays its frames), and only
 * one counter per stream keeps the client's ordering and gap detection exact.
 * Envelopes leave `emit()` with `seq: 0` until they are delivered.
 *
 * Also here: the translation of internal workflow / agent bus events onto v2
 * (`translateInternalEvent`), the projection of ledger events onto v2 for
 * re-sync (`projectLedgerEvent`) and the checkpoint → interaction mapping the
 * workflow bridge and the workflow stream share.
 *
 * @module services/loop/RunStream
 */
import { SSE_V2_EVENTS, RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { compactedFrameOf, parseSseV2EventData } from './contracts/sseV2.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'RunStream';

/**
 * Upper bound on streams remembered at once. Entries are evicted explicitly
 * when a stream is torn down (`resetStream`: chat client gone, execution
 * terminal) and, as a backstop, least-recently-used once the map is full —
 * a forgotten stream simply restarts its `seq` at 1, which the client treats
 * as a fresh stream.
 */
export const MAX_TRACKED_STREAMS = 10000;

/** streamId → last seq, so reconnects on the same stream keep increasing. */
const seqByStream = new Map();
/** streamId → current run binding `{ runId, emitter }` (chat turns register themselves). */
const currentByStream = new Map();
/**
 * runId → last run frame counter (`rseq`). Stamped by the producer, so a frame
 * carries the same number whichever worker delivers it: a re-attaching client
 * and the resume snapshot (`services/chat/chatResume.js`) agree on what "up to
 * here" means. Not the stream `seq`, which the delivering worker assigns.
 */
const rseqByRun = new Map();
let deliver = null;

/** Re-insert `key` so Map iteration order doubles as LRU order; evict the oldest past the cap. */
function touch(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_STREAMS) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

/** Install the delivery function `(streamId, envelope) => boolean` (server/sse.js). */
export function setEnvelopeDelivery(fn) {
  deliver = typeof fn === 'function' ? fn : null;
}

/** Observers of every envelope an emitter produces, delivered or not. */
const emitObservers = new Set();

/**
 * Watch every envelope `RunStreamEmitter.emit` produces, on any stream, before
 * delivery — so a frame nobody is connected to receive is seen as well. Used
 * to record what a chat turn did (`services/chat/runActivity.js`). An observer
 * must be cheap and must not throw into the producer.
 *
 * @param {(envelope: Object, streamId: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function observeEmittedEnvelopes(fn) {
  if (typeof fn !== 'function') return () => {};
  emitObservers.add(fn);
  return () => emitObservers.delete(fn);
}

function notifyEmitObservers(envelope, streamId) {
  for (const fn of emitObservers) {
    try {
      fn(envelope, streamId);
    } catch (err) {
      logger.warn('SSE v2 emit observer failed', {
        component: COMPONENT,
        type: envelope?.type,
        error: err.message
      });
    }
  }
}

export function nextSeq(streamId) {
  const next = (seqByStream.get(streamId) || 0) + 1;
  touch(seqByStream, streamId, next);
  return next;
}

/** Number of streams currently tracked (tests / diagnostics). */
export function trackedStreamCount() {
  return seqByStream.size;
}

export function currentSeq(streamId) {
  return seqByStream.get(streamId) || 0;
}

/** The last run frame counter stamped for `runId` on this worker (0 when none). */
export function currentRseq(runId) {
  return rseqByRun.get(runId) || 0;
}

function nextRseq(runId) {
  const next = (rseqByRun.get(runId) || 0) + 1;
  touch(rseqByRun, runId, next);
  return next;
}

/**
 * Forget a stream: its `seq` counter and run binding. Called when the stream
 * is gone for good — the chat's SSE client entry was removed, a workflow /
 * agent execution reached a terminal state — so the registry stays bounded.
 *
 * Text still waiting in the stream's coalescing window (up to
 * DELTA_COALESCE_MS of deltas) is dropped, not delivered: the chat callers
 * reset only after their client is gone, and an execution's terminal frame,
 * like any non-delta frame, has already flushed the window before the reset.
 */
export function resetStream(streamId) {
  seqByStream.delete(streamId);
  currentByStream.delete(streamId);
  const slot = coalescing.get(streamId);
  if (slot) {
    clearTimeout(slot.timer);
    coalescing.delete(streamId);
  }
}

/**
 * Build one v2 envelope. Validates `data` against the contract for `type`
 * (throws a ZodError on mismatch — a producer bug, never a runtime condition).
 * `seq` is 0 unless given explicitly (ledger projections carry the ledger seq);
 * the delivering worker stamps the stream sequence (`stampSeq`).
 */
export function buildEnvelope({ streamId, runId, type, data, seq }) {
  const parsed = parseSseV2EventData(type, data ?? {});
  return {
    v: 2,
    seq: Number.isInteger(seq) ? seq : 0,
    runId: runId || streamId,
    ts: new Date().toISOString(),
    type,
    data: parsed
  };
}

/**
 * Assign the next stream sequence number to an envelope about to be written to
 * the client. Called by the delivering worker only (server/sse.js).
 * @returns {Object} a stamped copy
 */
export function stampSeq(streamId, envelope) {
  return { ...envelope, seq: nextSeq(streamId) };
}

// ── text delta coalescing ───────────────────────────────────────────────────

/**
 * How long consecutive text / thinking deltas of one stream are merged into one
 * frame. A model streams one token per chunk (40/s and more), and in cluster
 * mode almost every frame crosses workers through the primary
 * (`server/clusterBus.js`), so a frame per token is the bus's main traffic.
 * The first delta after a quiet window goes out at once (no added latency to
 * the first token); deltas arriving within the window are appended to one
 * pending frame, sent when the window ends. Any other frame on the stream
 * flushes the pending one first, so order is unchanged.
 */
export const DELTA_COALESCE_MS = 50;

/** streamId → `{ pending: envelope|null, timer }` while a window is open. */
const coalescing = new Map();

/** A delta whose `content` can be appended to: text or thinking, no metadata. */
function isMergeableDelta(envelope) {
  const d = envelope.data;
  return (
    envelope.type === SSE_V2_EVENTS.STEP_DELTA &&
    (d.kind === 'text' || d.kind === 'thinking') &&
    typeof d.content === 'string' &&
    d.meta === undefined
  );
}

function sameDelta(a, b) {
  return a.runId === b.runId && a.data.step === b.data.step && a.data.kind === b.data.kind;
}

function sendNow(streamId, envelope) {
  if (!deliver) return;
  try {
    deliver(streamId, envelope);
  } catch (err) {
    logger.warn('SSE v2 delivery failed', {
      component: COMPONENT,
      streamId,
      type: envelope.type,
      error: err.message
    });
  }
}

function openWindow(streamId) {
  const slot = { pending: null, timer: null };
  const tick = () => {
    if (coalescing.get(streamId) !== slot) return;
    if (!slot.pending) {
      coalescing.delete(streamId);
      return;
    }
    const pending = slot.pending;
    slot.pending = null;
    slot.timer = setTimeout(tick, DELTA_COALESCE_MS);
    sendNow(streamId, pending);
  };
  slot.timer = setTimeout(tick, DELTA_COALESCE_MS);
  coalescing.set(streamId, slot);
}

/**
 * Close the stream's window, delivering what it holds. Exported for the
 * resume snapshot, which must not straddle a half-filled window, and for a
 * POST stream about to end.
 */
export function flushStream(streamId) {
  const slot = coalescing.get(streamId);
  if (!slot) return;
  clearTimeout(slot.timer);
  coalescing.delete(streamId);
  if (slot.pending) sendNow(streamId, slot.pending);
}

/** Deliver through the installed delivery function, merging deltas per window. */
function deliverCoalesced(streamId, envelope) {
  const delta = isMergeableDelta(envelope);
  const slot = coalescing.get(streamId);
  if (slot && delta) {
    if (!slot.pending) {
      slot.pending = { ...envelope, data: { ...envelope.data } };
      return;
    }
    if (sameDelta(slot.pending, envelope)) {
      slot.pending.data.content += envelope.data.content;
      // The merged frame holds every chunk up to this one.
      if (envelope.rseq) slot.pending.rseq = envelope.rseq;
      return;
    }
  }
  flushStream(streamId);
  sendNow(streamId, envelope);
  if (delta) openWindow(streamId);
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
    // Only frames on the installed delivery (the chat stream) are numbered per
    // run: an override is an in-process sink nobody re-attaches to.
    if (!this._deliver) envelope.rseq = nextRseq(envelope.runId);
    if (emitObservers.size > 0) notifyEmitObservers(envelope, this.streamId);
    // A delivery override is an in-process sink (an API response, a recorder)
    // with nothing to relay, so only the installed delivery coalesces.
    if (!this._deliver) {
      deliverCoalesced(this.streamId, envelope);
      return envelope;
    }
    try {
      this._deliver(this.streamId, envelope);
    } catch (err) {
      logger.warn('SSE v2 delivery failed', {
        component: COMPONENT,
        streamId: this.streamId,
        type,
        error: err.message
      });
    }
    return envelope;
  }
}

/** Register the emitter that currently produces a stream's run (chat turn in flight). */
export function bindStreamRun(streamId, runId, emitter) {
  touch(currentByStream, streamId, { runId, emitter });
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

const CHECKPOINT_KIND = {
  approval: 'approval',
  review: 'review',
  input: 'question',
  question: 'question'
};

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
  // A question checkpoint (ask_user inside a node) states its widget; a
  // human `input` node is a text / form widget regardless of options.
  const inputType =
    cp.inputType ||
    (cp.type === 'input' || cp.type === 'question'
      ? cp.inputSchema
        ? 'form'
        : 'text'
      : options?.length
        ? 'single_select'
        : 'confirm');
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
      ...(cp.placeholder ? { placeholder: String(cp.placeholder) } : {}),
      ...(cp.validation && typeof cp.validation === 'object' ? { validation: cp.validation } : {}),
      ...(cp.context ? { context: String(cp.context) } : {}),
      allowSkip: cp.allowSkip === true,
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
      // A chat turn that stopped for a clarification or an approval ends its
      // segment with status `paused`; the run continues under the same id
      // once the person answers (`run/resumed` follows), so a replay shows a
      // pause, not an end.
      if (d.status === 'paused') {
        return [wrap(SSE_V2_EVENTS.RUN_PAUSED, { reason: 'interaction' })];
      }
      return [
        wrap(SSE_V2_EVENTS.RUN_ENDED, {
          status: d.status || 'completed',
          finishReason: d.finishReason ?? null,
          ...(d.usage ? { usage: d.usage } : {}),
          ...(Array.isArray(d.knowledgeSources) ? { knowledgeSources: d.knowledgeSources } : {}),
          ...(Array.isArray(d.answerBasis) ? { answerBasis: d.answerBasis } : {}),
          ...(d.limitReachedIn ? { limitReachedIn: d.limitReachedIn } : {}),
          ...(d.provenance ? { provenance: d.provenance } : {}),
          // Who stopped an aborted run, so a replay says what the live stream said.
          ...(d.cause ? { cause: d.cause } : {}),
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
          ...(d.title ? { title: String(d.title) } : {}),
          ...(d.integration ? { integration: String(d.integration) } : {}),
          ...(d.activityKind ? { activityKind: d.activityKind } : {}),
          ...(d.activityOrigin ? { activityOrigin: d.activityOrigin } : {}),
          args: d.args,
          execution: d.execution || 'server',
          // Only a call that shared its batch carries its place (`callIndex`).
          ...(Number.isInteger(d.callIndex) && Number.isInteger(d.parallelGroup)
            ? { parallelGroup: d.parallelGroup, callIndex: d.callIndex }
            : {})
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
          ...(d.knowledgeSource ? { knowledgeSource: d.knowledgeSource } : {}),
          ...(d.activityOrigin ? { activityOrigin: d.activityOrigin } : {}),
          ...(Number.isInteger(d.resultCount) ? { resultCount: d.resultCount } : {}),
          ...(d.readOutcome ? { readOutcome: d.readOutcome } : {}),
          ...(Array.isArray(d.places) && d.places.length ? { places: d.places } : {})
        })
      ];
    case RUN_LOG_EVENTS.SOURCES_ADDED:
      return [wrap(SSE_V2_EVENTS.SOURCES_ADDED, d)];
    case RUN_LOG_EVENTS.KNOWLEDGE_SCOPE:
      return [wrap(SSE_V2_EVENTS.KNOWLEDGE_SCOPE, d)];
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
    case RUN_LOG_EVENTS.CONTEXT_COMPACTION:
      // A compaction the chat shows as an activity row (#3819). Journals
      // written before it carried an id have none, and no row.
      return d.compactionId ? [wrap(SSE_V2_EVENTS.CONTEXT_COMPACTED, compactedFrameOf(d))] : [];
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
