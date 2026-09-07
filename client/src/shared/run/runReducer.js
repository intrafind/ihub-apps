/**
 * SSE v2 run reducer — the ONE client-side interpretation of run events.
 *
 * Every run-scoped stream (chat, workflow execution, agent run) delivers the
 * same envelopes (`{ v: 2, seq, runId, ts, type, data }`, see
 * shared/runEvents.js and server/services/loop/contracts/sseV2.js). This
 * reducer folds them into a plain, serialisable stream state:
 *
 *   StreamState { streamId, connected, lastSeq, gap, runs: { [runId]: RunState }, order, activeRunId, error }
 *   RunState    { runId, kind, status, refs, model, text, thinking, images, steps, tools, progress,
 *                 nodes, interactions, pendingInteractionId, meta, knowledgeSources, citations, … }
 *
 * Surfaces project this state onto their own view (a chat message, a
 * workflow execution page) — they never interpret event names themselves.
 * The reducer is pure and framework-free so it can be unit-tested and reused
 * on the server.
 *
 * @module shared/run/runReducer
 */
import { SSE_V2_EVENTS } from '../../../../shared/runEvents.js';

export const RUN_EVENTS = SSE_V2_EVENTS;

const TERMINAL_STATUSES = new Set(['completed', 'aborted', 'error', 'budget_exhausted']);

export function createStreamState(streamId = null) {
  return {
    streamId,
    connected: false,
    protocol: null,
    lastSeq: 0,
    /** Set when a sequence gap was observed: { expected, received, runId }. */
    gap: null,
    runs: {},
    order: [],
    activeRunId: null,
    /** Stream-level error (no run to attach it to). */
    error: null,
    lastEnvelope: null
  };
}

export function createRunState(runId, init = {}) {
  return {
    runId,
    kind: init.kind || null,
    status: 'running',
    startedAt: init.startedAt || null,
    endedAt: null,
    /** ts of the last run/started|ended|paused|resumed frame — null while only inferred. */
    lastLifecycleAt: null,
    finishReason: null,
    usage: null,
    refs: init.refs || {},
    model: init.model || null,
    parentRunId: init.parentRunId || null,
    // answer content
    text: '',
    thinking: [],
    images: [],
    steps: {},
    currentStep: 0,
    // tools
    tools: [],
    // free-form progress (tool/progress + progress/node, in arrival order)
    progress: [],
    nodes: {},
    nodeOrder: [],
    // interactions
    interactions: {},
    interactionOrder: [],
    pendingInteractionId: null,
    // surface metadata
    meta: { extra: {} },
    knowledgeSources: [],
    citations: [],
    skills: [],
    searchStatus: null,
    grounding: null,
    output: undefined,
    toolName: null,
    error: null
  };
}

function union(list, items) {
  const out = [...list];
  for (const item of items || []) if (item && !out.includes(item)) out.push(item);
  return out;
}

function ensureRun(state, runId, init) {
  const existing = state.runs[runId];
  if (existing) return { state, run: existing };
  const run = createRunState(runId, init);
  return {
    state: {
      ...state,
      runs: { ...state.runs, [runId]: run },
      order: [...state.order, runId]
    },
    run
  };
}

function withRun(state, run) {
  return { ...state, runs: { ...state.runs, [run.runId]: run } };
}

function ensureStep(run, step) {
  const existing = run.steps[step];
  if (existing) return existing;
  return { step, text: '', thinking: [], images: [], completed: false, toolCalls: [] };
}

/**
 * Fold one envelope into the stream state. Unknown or malformed envelopes are
 * ignored (the state object is returned unchanged).
 *
 * @param {Object} state - StreamState
 * @param {Object} envelope - SSE v2 envelope
 * @returns {Object} new StreamState
 */
export function reduceRunEvent(state, envelope) {
  if (!envelope || envelope.v !== 2 || typeof envelope.type !== 'string') return state;
  const { type, runId, seq, ts } = envelope;
  const data = envelope.data || {};

  let next = { ...state, lastEnvelope: envelope };
  if (Number.isInteger(seq)) {
    if (state.lastSeq > 0 && seq > state.lastSeq + 1) {
      next.gap = { expected: state.lastSeq + 1, received: seq, runId };
    }
    if (seq > state.lastSeq) next.lastSeq = seq;
  }

  // ── stream-level frames ───────────────────────────────────────────────
  if (type === SSE_V2_EVENTS.STREAM_CONNECTED) {
    // A connection starts a new sequence epoch: the counter belongs to the
    // worker delivering this connection and may not continue the previous
    // one. When it does not (frames missed while disconnected, a counter that
    // restarted), the run announced by the frame is rebuilt from its ledger.
    const epochSeq = Number.isInteger(seq) ? seq : 0;
    const continues = state.lastSeq === 0 || epochSeq === state.lastSeq + 1;
    return {
      ...next,
      lastSeq: epochSeq,
      gap: continues ? null : { expected: state.lastSeq + 1, received: epochSeq, runId },
      connected: true,
      protocol: data.protocol || 2,
      error: null
    };
  }
  if (type === SSE_V2_EVENTS.STREAM_ERROR && !state.runs[runId]) {
    return { ...next, error: data };
  }

  // ── run-scoped events ─────────────────────────────────────────────────
  if (typeof runId !== 'string' || runId === '') return next;
  const ensured = ensureRun(
    next,
    runId,
    type === SSE_V2_EVENTS.RUN_STARTED
      ? {
          kind: data.kind,
          refs: data.refs,
          model: data.model,
          parentRunId: data.parentRunId,
          startedAt: ts
        }
      : {}
  );
  next = ensured.state;
  let run = ensured.run;

  switch (type) {
    case SSE_V2_EVENTS.RUN_STARTED:
      run = {
        ...run,
        kind: data.kind || run.kind,
        refs: { ...run.refs, ...(data.refs || {}) },
        model: data.model || run.model,
        parentRunId: data.parentRunId || run.parentRunId,
        startedAt: run.startedAt || ts,
        lastLifecycleAt: ts,
        status: 'running',
        error: null
      };
      return { ...withRun(next, run), activeRunId: runId };

    case SSE_V2_EVENTS.RUN_ENDED:
      run = {
        ...run,
        status: data.status || 'completed',
        finishReason: data.finishReason ?? null,
        usage: data.usage || run.usage,
        knowledgeSources: union(run.knowledgeSources, data.knowledgeSources),
        toolName: data.toolName || run.toolName,
        output: data.output !== undefined ? data.output : run.output,
        error: data.error || run.error,
        endedAt: ts,
        lastLifecycleAt: ts,
        pendingInteractionId: null
      };
      return withRun(next, run);

    case SSE_V2_EVENTS.RUN_PAUSED:
      run = {
        ...run,
        status: 'paused',
        lastLifecycleAt: ts,
        pendingInteractionId: data.interactionId || run.pendingInteractionId
      };
      return withRun(next, run);

    case SSE_V2_EVENTS.RUN_RESUMED: {
      const interactions = { ...run.interactions };
      const id = data.interactionId || run.pendingInteractionId;
      if (id && interactions[id] && interactions[id].status === 'pending') {
        interactions[id] = { ...interactions[id], status: 'answered' };
      }
      run = {
        ...run,
        status: 'running',
        lastLifecycleAt: ts,
        pendingInteractionId: null,
        interactions
      };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.STEP_DELTA: {
      const stepNo = Number.isInteger(data.step) ? data.step : run.currentStep;
      const step = { ...ensureStep(run, stepNo) };
      if (data.kind === 'text' && data.content) {
        step.text += data.content;
        run = { ...run, text: run.text + data.content };
      } else if (data.kind === 'thinking' && (data.content || data.meta)) {
        const thought = data.meta?.name
          ? { name: data.meta.name, content: data.content || '' }
          : data.content || '';
        step.thinking = [...step.thinking, thought];
        run = { ...run, thinking: [...run.thinking, thought] };
      } else if (data.kind === 'image' && data.image) {
        step.images = [...step.images, data.image];
        run = { ...run, images: [...run.images, data.image] };
      }
      run = { ...run, currentStep: stepNo, steps: { ...run.steps, [stepNo]: step } };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.STEP_COMPLETED: {
      const stepNo = Number.isInteger(data.step) ? data.step : run.currentStep;
      const prev = ensureStep(run, stepNo);
      // The completed content is the authoritative text of the step (the
      // ledger's message, or the model's final output): it replaces whatever
      // this step streamed, so lost or never-received deltas cannot leave the
      // answer truncated. A step without content (tool-call only) keeps the
      // streamed text untouched.
      const streamed = prev.text || '';
      const content = data.content || '';
      const base =
        streamed && run.text.endsWith(streamed)
          ? run.text.slice(0, run.text.length - streamed.length)
          : run.text;
      const text = content ? base + content : run.text;
      const step = {
        ...prev,
        completed: true,
        content,
        text: content || streamed,
        toolCalls: data.toolCalls || [],
        finishReason: data.finishReason ?? null,
        usage: data.usage || null,
        citations: data.citations,
        sources: data.sources,
        groundingMetadata: data.groundingMetadata
      };
      run = {
        ...run,
        text,
        currentStep: stepNo,
        steps: { ...run.steps, [stepNo]: step },
        knowledgeSources: union(run.knowledgeSources, data.sources),
        citations: data.citations ? [...run.citations, data.citations] : run.citations,
        usage: data.usage || run.usage
      };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.TOOL_STARTED: {
      const tool = {
        callId: data.callId,
        step: data.step,
        toolId: data.toolId,
        name: data.name,
        args: data.args,
        execution: data.execution || 'server',
        status: 'running',
        startedAt: ts,
        completedAt: null,
        result: undefined,
        error: null,
        durationMs: null,
        knowledgeSource: null
      };
      run = { ...run, tools: [...run.tools.filter(t => t.callId !== data.callId), tool] };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.TOOL_COMPLETED: {
      const idx = run.tools.findIndex(t => t.callId === data.callId);
      const base =
        idx >= 0
          ? run.tools[idx]
          : {
              callId: data.callId,
              step: data.step,
              toolId: data.toolId,
              name: data.name,
              args: undefined,
              execution: 'server',
              startedAt: null
            };
      const tool = {
        ...base,
        status: data.error ? 'error' : 'completed',
        result: data.resultPreview,
        error: data.error || null,
        durationMs: data.durationMs ?? null,
        knowledgeSource: data.knowledgeSource || null,
        completedAt: ts
      };
      const tools =
        idx >= 0 ? run.tools.map((t, i) => (i === idx ? tool : t)) : [...run.tools, tool];
      run = {
        ...run,
        tools,
        knowledgeSources: union(
          run.knowledgeSources,
          data.knowledgeSource ? [data.knowledgeSource] : []
        )
      };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.TOOL_PROGRESS: {
      const entry = { kind: 'tool/progress', at: ts, seq, runId, ...data };
      run = { ...run, progress: [...run.progress, entry] };
      switch (data.phase) {
        case 'search.status':
          run = { ...run, searchStatus: data.data ?? null };
          break;
        case 'citation':
          if (data.data) run = { ...run, citations: [...run.citations, data.data] };
          break;
        case 'skill.activation':
          run = {
            ...run,
            skills: [
              ...run.skills,
              {
                name: data.data?.skillName || data.message,
                description: data.data?.description || ''
              }
            ]
          };
          break;
        case 'grounding':
          run = { ...run, grounding: data.data ?? null };
          break;
        default:
          break;
      }
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.PROGRESS_NODE: {
      const nodeId = data.nodeId;
      const prevNode = run.nodes[nodeId] || {};
      const node = {
        ...prevNode,
        nodeId,
        executionId: data.executionId ?? prevNode.executionId,
        nodeName: data.nodeName ?? prevNode.nodeName,
        nodeType: data.nodeType ?? prevNode.nodeType,
        status: data.status,
        iteration: data.iteration ?? prevNode.iteration,
        progress: data.progress ?? prevNode.progress,
        output: data.output !== undefined ? data.output : prevNode.output,
        error: data.error ?? prevNode.error,
        updatedAt: ts
      };
      run = {
        ...run,
        nodes: { ...run.nodes, [nodeId]: node },
        nodeOrder: run.nodeOrder.includes(nodeId) ? run.nodeOrder : [...run.nodeOrder, nodeId],
        progress: [...run.progress, { kind: 'progress/node', at: ts, seq, runId, ...data }]
      };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.INTERACTION_RAISED: {
      const interaction = data.interaction;
      if (!interaction?.id) return withRun(next, run);
      run = {
        ...run,
        interactions: { ...run.interactions, [interaction.id]: interaction },
        interactionOrder: run.interactionOrder.includes(interaction.id)
          ? run.interactionOrder
          : [...run.interactionOrder, interaction.id],
        pendingInteractionId:
          interaction.status === 'pending' ? interaction.id : run.pendingInteractionId
      };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.INTERACTION_ANSWERED: {
      const id = data.interactionId;
      const prevInteraction = run.interactions[id] || { id, runId, kind: data.kind };
      run = {
        ...run,
        interactions: {
          ...run.interactions,
          [id]: { ...prevInteraction, status: 'answered', answer: data.answer }
        },
        pendingInteractionId: run.pendingInteractionId === id ? null : run.pendingInteractionId
      };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.META: {
      const { extra, ...rest } = data;
      run = {
        ...run,
        meta: { ...run.meta, ...rest, extra: { ...(run.meta.extra || {}), ...(extra || {}) } }
      };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.STREAM_ERROR:
      run = { ...run, error: data };
      return withRun(next, run);

    default:
      return next;
  }
}

/** Fold a batch of envelopes (e.g. a re-sync page). */
export function reduceRunEvents(state, envelopes) {
  return (envelopes || []).reduce(reduceRunEvent, state);
}

/**
 * Fold a re-sync page (`GET /api/runs/:runId/events?after=&view=sse`):
 * envelopes are validated, deduplicated by `seq` against `seenSeqs` (a
 * read-only Set the caller maintains — this function never mutates it) and
 * within the page, sorted by `seq`, folded, and the observed gap is cleared.
 * Pure: safe to call from a React reducer.
 *
 * @param {Object} state - StreamState
 * @param {Array<Object>} envelopes - Page of SSE v2 envelopes
 * @param {Set<number>} [seenSeqs] - Seqs already folded from the live stream
 * @returns {Object} new StreamState with `gap: null`
 */
/**
 * Rebuild one run from its ledger projection
 * (`GET /api/runs/:runId/events?view=sse`, ledger `seq` space).
 *
 * The ledger is authoritative: the run is recomputed from the page alone and
 * swapped into the stream state; the stream's own bookkeeping (`lastSeq`,
 * order, other runs) is untouched and the gap is cleared. Ledger `seq` values
 * belong to the run's own sequence space, so they are never compared with the
 * live stream's `seq`. Client-only accumulations the ledger does not carry
 * (node progress, meta) are kept from the live run when the page has none.
 *
 * @param {StreamState} state
 * @param {string} runId
 * @param {Array<Object>} envelopes - v2 envelopes of that run
 * @returns {StreamState}
 */
export function rebuildRunFromLedger(state, runId, envelopes) {
  const clearGap = s => (s.gap === null ? s : { ...s, gap: null });
  if (!runId) return clearGap(state);
  const page = (envelopes || [])
    .filter(e => e && e.v === 2 && typeof e.type === 'string' && e.runId === runId)
    .sort((a, b) => (Number.isInteger(a.seq) ? a.seq : 0) - (Number.isInteger(b.seq) ? b.seq : 0))
    // strip the ledger seq: it must not drive the live stream's gap detection
    .map(({ seq: _ledgerSeq, ...rest }) => rest);
  if (page.length === 0) return clearGap(state);
  const scratch = reduceRunEvents(createStreamState(state.streamId), page);
  const rebuilt = scratch.runs[runId];
  if (!rebuilt) return clearGap(state);
  const live = state.runs[runId];
  const run = live
    ? {
        ...rebuilt,
        progress: rebuilt.progress.length ? rebuilt.progress : live.progress,
        nodes: Object.keys(rebuilt.nodes).length ? rebuilt.nodes : live.nodes,
        nodeOrder: rebuilt.nodeOrder.length ? rebuilt.nodeOrder : live.nodeOrder,
        meta: {
          ...live.meta,
          ...rebuilt.meta,
          extra: { ...live.meta?.extra, ...rebuilt.meta?.extra }
        }
      }
    : rebuilt;
  const order = state.order.includes(runId) ? state.order : [...state.order, runId];
  return {
    ...state,
    runs: { ...state.runs, [runId]: run },
    order,
    activeRunId: state.activeRunId || runId,
    gap: null
  };
}

// ── selectors ──────────────────────────────────────────────────────────────

export function getRun(state, runId) {
  return (runId && state?.runs?.[runId]) || null;
}

export function getActiveRun(state) {
  return getRun(state, state?.activeRunId);
}

export function getLatestRun(state) {
  const id = state?.order?.[state.order.length - 1];
  return getRun(state, id);
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function isRunFinished(run) {
  return !!run && isTerminalStatus(run.status);
}

export function getPendingInteraction(run) {
  if (!run) return null;
  const id = run.pendingInteractionId;
  if (id && run.interactions[id]) return run.interactions[id];
  for (let i = run.interactionOrder.length - 1; i >= 0; i--) {
    const it = run.interactions[run.interactionOrder[i]];
    if (it?.status === 'pending') return it;
  }
  return null;
}

/** Tools in call order with their current status. */
export function getTools(run) {
  return run ? run.tools : [];
}

/** Nodes in first-seen order. */
export function getNodes(run) {
  return run ? run.nodeOrder.map(id => run.nodes[id]) : [];
}

/** Runs in first-seen order. */
export function getRuns(state) {
  return state?.order ? state.order.map(id => state.runs[id]).filter(Boolean) : [];
}

/** Interactions of a run in raised order. */
export function getInteractions(run) {
  return run ? run.interactionOrder.map(id => run.interactions[id]).filter(Boolean) : [];
}

/**
 * Progress entries (`tool/progress` + `progress/node`) of every run on the
 * stream, interleaved by stream sequence. Entries without a seq (client-side
 * synthetic frames) keep their arrival position.
 */
export function getStreamProgress(state) {
  const all = [];
  for (const run of getRuns(state)) {
    for (const entry of run.progress) all.push(entry);
  }
  return all
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const sa = Number.isInteger(a.entry.seq) ? a.entry.seq : null;
      const sb = Number.isInteger(b.entry.seq) ? b.entry.seq : null;
      if (sa !== null && sb !== null && sa !== sb) return sa - sb;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/** Every run's interaction list, root/first-seen run first. */
export function getStreamInteractions(state) {
  const all = [];
  for (const run of getRuns(state)) for (const it of getInteractions(run)) all.push(it);
  return all;
}
