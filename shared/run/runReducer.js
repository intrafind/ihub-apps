// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 *                 argStreams, argOrder, waiting,
 *                 nodes, interactions, pendingInteractionId, meta, knowledgeSources, sources, … }
 *
 * Surfaces project this state onto their own view (a chat message, a
 * workflow execution page) — they never interpret event names themselves.
 * The reducer is pure and framework-free so it can be unit-tested and reused
 * on the server.
 *
 * @module shared/run/runReducer
 */
import { SSE_V2_EVENTS } from '../runEvents.js';
import { emptySourceSet, mergeSources } from '../sources/sourceSet.js';
import { generatedFilesOf } from '../generatedFiles.js';
import { ARGS_OUTCOMES, KNOWN_ARGS_OUTCOMES, PROGRESS_PHASES } from './argProgress.js';

const TERMINAL_STATUSES = new Set(['completed', 'aborted', 'error', 'budget_exhausted']);

/**
 * `tool/progress` phases that describe a tool call whose arguments are still
 * being written by the model, and the model call itself (issue #3534). They
 * are folded into `run.argStreams` and `run.waiting`, never appended to
 * `run.progress`: they repeat about once a second, so keeping every frame
 * would grow the list without end, and `progress` is read for things (the
 * page being fetched, skill activations) that these frames are not.
 */
const ARG_PHASE = PROGRESS_PHASES.ARGS;
const ARG_ENDED_PHASE = PROGRESS_PHASES.ARGS_ENDED;
const WAITING_PHASE = PROGRESS_PHASES.MODEL_WAITING;

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
    // How full the model's context window is, as the server counts it.
    context: null,
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
    // Calls whose arguments the model is still writing (`tool/progress` phases
    // `args` and `args.ended`), by call id, and the order they first appeared in.
    // One entry per call, updated in place: the row keeps its place and its id
    // matches the later `tool/started` and `tool/completed`.
    argStreams: {},
    argOrder: [],
    // The model call has shown nothing for a while (`model.waiting`), or null.
    waiting: null,
    nodes: {},
    nodeOrder: [],
    // interactions
    interactions: {},
    interactionOrder: [],
    pendingInteractionId: null,
    // surface metadata
    meta: { extra: {} },
    // What the answer is based on, as the server named it on `run/ended`
    // (`answerBasis`: the kinds of source) — never gathered here from the
    // tools or steps, so the footer's chip shows exactly what the server
    // reported. Null: the run ended without one (failed, stopped before it
    // wrote anything, not a chat turn) and the answer shows no chip.
    answerBasis: null,
    // Which projects the turn reached and whether each was loaded or searched.
    knowledgeScope: null,
    // Everything the run's producers found (`sources/added`, shared/sources).
    sources: emptySourceSet(),
    skills: [],
    searchStatus: null,
    // Accumulated across every retrieval round of the turn, because
    // `searchStatus` only ever holds the newest event and a workspace-profile
    // turn searches several times: without this, "found 3 documents" replaces
    // "found 12 documents" and the turn reads as one small search.
    searchSummary: null,
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

/** An empty search summary. */
function emptySearchSummary() {
  return {
    queries: [],
    applications: [],
    sources: [],
    totalHits: 0,
    rounds: 0,
    searching: false
  };
}

/**
 * Fold one search status event into the turn's running summary.
 *
 * The iAssistant searches repeatedly within a single turn — it assesses what
 * it knows, searches, reassesses, searches again — and reports each round
 * with its own started/finished pair. The summary keeps the union of the
 * queries and the sum of the hits so the finished message can say what the
 * whole turn looked for and how much it found, the way the iAssistant webapp
 * does. Status events that are not search events (assess, plan, …) pass
 * through untouched.
 *
 * @param {Object|null} summary - the summary so far
 * @param {Object|null} status - the search status event
 * @returns {Object|null} the new summary
 */
function accumulateSearch(summary, status) {
  const event = status?.event;
  if (event !== 'search.started' && event !== 'search.finished') return summary;

  const next = { ...(summary || emptySearchSummary()) };

  if (event === 'search.started') {
    next.queries = union(next.queries, status.queries);
    next.rounds += 1;
    next.searching = true;
    return next;
  }

  next.totalHits += Number.isFinite(status.numberOfHits) ? status.numberOfHits : 0;
  next.applications = union(next.applications, status.applications);
  next.sources = union(next.sources, status.sources);
  next.searching = false;
  // A finished event without a preceding started one still counts as a round,
  // so a summary never reports zero rounds while reporting hits.
  if (next.rounds === 0) next.rounds = 1;
  return next;
}

/**
 * Merge provider grounding metadata that arrives piecemeal (Anthropic streams
 * one citation per `citations_delta` and one result block per search): array
 * fields are concatenated, scalar fields take the latest value.
 */
export function mergeGrounding(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') return existing ?? null;
  if (!existing) return { ...incoming };
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) merged[key] = [...(existing[key] || []), ...value];
    else if (value !== undefined) merged[key] = value;
  }
  return merged;
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
 * Append a thought, merging it into the previous one when both are raw text.
 *
 * Providers stream reasoning one token at a time (vLLM/OpenAI `delta.reasoning`,
 * one SSE frame per token), so appending every delta as its own entry rendered
 * the thinking as one bullet per word. Text deltas are concatenated the same way
 * a few lines above; this gives reasoning the same treatment.
 *
 * Named thoughts (`{ name, content }`) are discrete semantic events — workflow
 * phases and the like — so they stay separate entries and also break the run of
 * text, which is what keeps a named thought from swallowing the stream after it.
 */
function appendThought(list, thought) {
  const last = list[list.length - 1];
  if (typeof thought === 'string' && typeof last === 'string') {
    return [...list.slice(0, -1), last + thought];
  }
  return [...list, thought];
}

/**
 * Add a skill to the turn's skill set, once.
 *
 * A skill is activated more than once in a turn — the user's `/name` and then
 * the model loading it, or the model loading it again in a later round — and
 * each activation is its own `skill.activation` frame. The set holds the skill
 * a single time (matched by `id` when both have one, else by display name) and
 * keeps its first entry. Only `id`, a description and `activatedBy` are filled
 * in from later ones, and `user` wins over `model`: a skill only users may
 * start stays active in the next turns only when a user activated it.
 *
 * @param {Object[]} skills - the turn's skills so far
 * @param {{name: string, description: string, id?: string, activatedBy?: 'user'|'model'}} skill
 * @returns {Object[]} a new list
 */
export function foldSkill(skills, skill) {
  const index = skills.findIndex(known =>
    known.id && skill.id ? known.id === skill.id : known.name === skill.name
  );
  if (index < 0) return [...skills, skill];
  const known = skills[index];
  const activatedBy =
    known.activatedBy === 'user' || skill.activatedBy === 'user'
      ? 'user'
      : known.activatedBy || skill.activatedBy;
  const merged = {
    ...known,
    description: known.description || skill.description,
    ...(!known.id && skill.id ? { id: skill.id } : {}),
    ...(activatedBy ? { activatedBy } : {})
  };
  return skills.map((entry, i) => (i === index ? merged : entry));
}

/** A finite number, or `fallback`. */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A non-empty string, or null. */
function textOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The monotonic clock the client measures a progress frame's age against. An
 * envelope may carry its own `receivedAt` (tests, replays); a live frame is
 * stamped when it is folded. Never the wall clock: a wrong system time must not
 * move the stopwatch the user reads.
 */
function frameClock(envelope) {
  if (typeof envelope.receivedAt === 'number' && Number.isFinite(envelope.receivedAt)) {
    return envelope.receivedAt;
  }
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** The `data` object of a frame, or an empty one. */
function detailOf(frame) {
  return frame.data && typeof frame.data === 'object' ? frame.data : {};
}

/** The run with one call's stream entry replaced, and the model no longer silent. */
function withArgStream(run, entry, extra = {}) {
  return {
    ...run,
    ...extra,
    argStreams: { ...run.argStreams, [entry.callId]: entry },
    // The row exists, so the model is no longer silent.
    waiting: null
  };
}

/**
 * Fold `args.ended`: the model stopped writing a call's arguments. Only an
 * announced call can end, and it ends once.
 */
function foldArgsEnded(run, known, detail, when) {
  if (!known || known.ended) return run;
  // An outcome the client does not know yet is read as `ready`, so the wire can grow.
  const outcome = KNOWN_ARGS_OUTCOMES.has(detail.outcome) ? detail.outcome : ARGS_OUTCOMES.READY;
  const argBytes = Math.max(known.argBytes, finiteOr(detail.argBytes, known.argBytes));
  const elapsedMs = Math.max(known.elapsedMs, finiteOr(detail.elapsedMs, known.elapsedMs));
  return withArgStream(run, {
    ...known,
    argBytes,
    elapsedMs,
    receivedAt: when.receivedAt,
    grewAtMs: argBytes > known.argBytes ? elapsedMs : known.grewAtMs,
    ended: { outcome, argBytes, elapsedMs, receivedAt: when.receivedAt }
  });
}

/**
 * What the server decided the call is (`utils/toolDisplay`): the first frame
 * that names a field wins, later frames only fill gaps.
 */
function argDisplayFields(frame, detail, known) {
  const occurrence = finiteOr(detail.occurrence, 0);
  return {
    toolId: textOrNull(frame.toolId) || known?.toolId || null,
    name: textOrNull(detail.name) || known?.name || null,
    title: textOrNull(detail.title) || known?.title || null,
    integration: textOrNull(detail.integration) || known?.integration || null,
    activityKind: textOrNull(detail.activityKind) || known?.activityKind || null,
    outputKind: textOrNull(detail.outputKind) || known?.outputKind || null,
    occurrence: occurrence > 1 ? occurrence : (known?.occurrence ?? null)
  };
}

/** Where the call sits in the list: when it first appeared, and among how many started calls. */
function argPlaceFields(run, known, when) {
  if (known) {
    const { firstSeen, afterTools, firstSeenAt, firstReceivedAt } = known;
    return { firstSeen, afterTools, firstSeenAt, firstReceivedAt };
  }
  return {
    firstSeen: run.argOrder.length,
    afterTools: run.tools.length,
    firstSeenAt: when.ts || null,
    firstReceivedAt: when.receivedAt
  };
}

/** Fold `args`: the model is writing a call's arguments, `argBytes` so far. */
function foldArgsProgress(run, frame, known, detail, when) {
  if (known?.ended) return run;
  const argBytes = Math.max(known?.argBytes ?? 0, finiteOr(detail.argBytes, 0));
  const elapsedMs = Math.max(known?.elapsedMs ?? 0, finiteOr(detail.elapsedMs, 0));
  const entry = {
    callId: frame.callId,
    step: Number.isInteger(frame.step) ? frame.step : (known?.step ?? null),
    ...argDisplayFields(frame, detail, known),
    argBytes,
    elapsedMs,
    receivedAt: when.receivedAt,
    // The server clock reading at which the size last grew: a call whose size
    // sits still for long is stalled (the client measures it, see
    // `isStalled` in features/chat/activityTiming.js).
    grewAtMs: !known || argBytes > known.argBytes ? elapsedMs : known.grewAtMs,
    ...argPlaceFields(run, known, when),
    ended: null
  };
  return withArgStream(run, entry, {
    argOrder: known ? run.argOrder : [...run.argOrder, entry.callId]
  });
}

/**
 * Fold a `tool/progress` frame of phase `args` or `args.ended`: the model is
 * writing the arguments of a call, or has stopped.
 *
 * One entry per call id, updated in place. Values on the wire are absolute, so
 * `argBytes` is kept at its maximum (a replayed or reordered frame cannot make
 * it shrink) and a frame after `args.ended` is ignored. The entry remembers how
 * many tool calls had started when it first appeared (`afterTools`), which is
 * what lets `buildToolActivity` keep the row where it first showed up even
 * though `tool/started` later moves the call to the end of `run.tools`.
 *
 * @param {Object} run - RunState
 * @param {Object} frame - the `tool/progress` frame (`phase`, `callId`, `toolId`, `step`, `data`)
 * @param {{ts: string|undefined, receivedAt: number}} when - server time and client clock of the frame
 * @returns {Object} the new RunState (the same object when the frame changes nothing)
 */
function foldArgFrame(run, frame, when) {
  const callId = textOrNull(frame.callId);
  if (!callId) return run;
  const known = run.argStreams[callId];
  const detail = detailOf(frame);
  return frame.phase === ARG_ENDED_PHASE
    ? foldArgsEnded(run, known, detail, when)
    : foldArgsProgress(run, { ...frame, callId }, known, detail, when);
}

/**
 * Visible model output ends the waiting line: answer text and images always;
 * reasoning too, unless the server already said the silence is reasoning
 * (`waiting.reasoning`), in which case the "Thinking" line stays up while the
 * thoughts stream instead of flickering with every token.
 */
function clearWaitingOnOutput(run, delta) {
  if (!run.waiting) return run;
  const visible =
    (delta.kind === 'text' && delta.content) ||
    (delta.kind === 'image' && delta.image) ||
    (delta.kind === 'thinking' && (delta.content || delta.meta) && !run.waiting.reasoning);
  return visible ? { ...run, waiting: null } : run;
}

/**
 * Fold a `model.waiting` frame: the model call has produced nothing visible for
 * a while. `data.reasoning` is the server's statement that the silence is the
 * model reasoning; the client never infers it. A frame that arrives after the
 * run ended is a late straggler and is dropped.
 */
function foldWaitingFrame(run, frame, when) {
  if (TERMINAL_STATUSES.has(run.status)) return run;
  const detail = detailOf(frame);
  return {
    ...run,
    waiting: {
      step: Number.isInteger(frame.step) ? frame.step : null,
      elapsedMs: Math.max(0, finiteOr(detail.elapsedMs, 0)),
      reasoning: detail.reasoning === true,
      receivedAt: when.receivedAt
    }
  };
}

/**
 * Fold a `tool/progress` frame of one of the live phases (`args`,
 * `args.ended`, `model.waiting`) into the run's own state.
 *
 * @returns {Object|null} the new RunState, or null when the frame is another phase
 */
function foldLiveProgress(run, frame, envelope) {
  const when = { ts: envelope.ts, receivedAt: frameClock(envelope) };
  if (frame.phase === ARG_PHASE || frame.phase === ARG_ENDED_PHASE) {
    return foldArgFrame(run, frame, when);
  }
  return frame.phase === WAITING_PHASE ? foldWaitingFrame(run, frame, when) : null;
}

/** The skill a `skill.activation` frame names, for `foldSkill`. */
function activatedSkillOf(frame) {
  const detail = frame.data;
  return {
    name: detail?.skillName || frame.message,
    description: detail?.description || '',
    // The global skill name or user skill id the next turns of the chat keep
    // the skill active by (`name` is for display).
    ...(typeof detail?.skillId === 'string' && detail.skillId ? { id: detail.skillId } : {}),
    // Who activated it: a skill only users may start stays active only when a
    // user did.
    ...(detail?.activatedBy === 'user' || detail?.activatedBy === 'model'
      ? { activatedBy: detail.activatedBy }
      : {})
  };
}

/**
 * Fold a `tool/progress` frame. Arguments being written and the model's
 * silence have their own state (see `ARG_PHASE`) and never reach
 * `run.progress`; every other phase is appended to it, and a few also fold
 * into state of their own.
 */
function foldToolProgress(run, frame, envelope) {
  const live = foldLiveProgress(run, frame, envelope);
  if (live) return live;
  const { ts, seq, runId } = envelope;
  const entry = { kind: 'tool/progress', at: ts, seq, runId, ...frame };
  const appended = { ...run, progress: [...run.progress, entry] };
  switch (frame.phase) {
    case 'search.status':
      return {
        ...appended,
        searchStatus: frame.data ?? null,
        searchSummary: accumulateSearch(appended.searchSummary, frame.data)
      };
    case 'skill.activation':
      // `run.skills` is the set of skills the turn used, one entry each. Every
      // activation (the user's `/name`, each time the model loads it) stays on
      // `run.progress` for the thought chain to list.
      return { ...appended, skills: foldSkill(appended.skills, activatedSkillOf(frame)) };
    case 'grounding':
      return { ...appended, grounding: mergeGrounding(appended.grounding, frame.data) };
    default:
      return appended;
  }
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
        refs: { ...run.refs, ...data.refs },
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
        context: data.context || run.context,
        answerBasis:
          Array.isArray(data.answerBasis) && data.answerBasis.length > 0 ? data.answerBasis : null,
        provenance: data.provenance || run.provenance,
        toolName: data.toolName || run.toolName,
        output: data.output !== undefined ? data.output : run.output,
        error: data.error || run.error,
        // Set on an aborted run: who stopped it (see `abortCause.js` on the server).
        cause: data.cause || run.cause,
        endedAt: ts,
        lastLifecycleAt: ts,
        pendingInteractionId: null,
        waiting: null
      };
      return withRun(next, run);

    case SSE_V2_EVENTS.RUN_PAUSED:
      run = {
        ...run,
        status: 'paused',
        lastLifecycleAt: ts,
        pendingInteractionId: data.interactionId || run.pendingInteractionId,
        waiting: null
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
        step.thinking = appendThought(step.thinking, thought);
        run = { ...run, thinking: appendThought(run.thinking, thought) };
      } else if (data.kind === 'image' && data.image) {
        step.images = [...step.images, data.image];
        run = { ...run, images: [...run.images, data.image] };
      }
      run = { ...run, currentStep: stepNo, steps: { ...run.steps, [stepNo]: step } };
      run = clearWaitingOnOutput(run, data);
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
        sources: data.sources,
        groundingMetadata: data.groundingMetadata
      };
      run = {
        ...run,
        text,
        currentStep: stepNo,
        steps: { ...run.steps, [stepNo]: step },
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
        // What the user reads instead of the id (server `utils/toolDisplay`).
        title: data.title || null,
        integration: data.integration || null,
        // The row the server decided on (search / fetch / tool) and where it looked.
        activityKind: data.activityKind || null,
        activityScope: data.activityScope || null,
        args: data.args,
        execution: data.execution || 'server',
        status: 'running',
        startedAt: ts,
        completedAt: null,
        result: undefined,
        error: null,
        durationMs: null,
        knowledgeSource: null,
        // What the call found (`sources/added` with its callId).
        sources: [],
        // MCP App view the tool renders (server + `ui://` resource).
        mcpApp: data.mcpApp || null
      };
      // A tool row is visible output: the model is no longer silent.
      run = {
        ...run,
        tools: [...run.tools.filter(t => t.callId !== data.callId), tool],
        waiting: null
      };
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
        sources: Array.isArray(base.sources) ? base.sources : [],
        // The finished MCP App view: tool input + the full result it draws.
        mcpApp: data.mcpApp || base.mcpApp || null,
        // A per-user OAuth MCP server the user must connect first.
        authRequired: data.authRequired || null,
        // A scheduled task a scheduling tool proposed (confirmation card).
        scheduledTaskProposal: data.scheduledTaskProposal || null,
        // Files the tool generated for the user (download cards).
        files: generatedFilesOf(data.files),
        completedAt: ts
      };
      const tools =
        idx >= 0 ? run.tools.map((t, i) => (i === idx ? tool : t)) : [...run.tools, tool];
      run = { ...run, tools };
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.KNOWLEDGE_SCOPE:
      return withRun(next, { ...run, knowledgeScope: data || null });

    case SSE_V2_EVENTS.CONTEXT_USAGE:
      return withRun(next, { ...run, context: data || run.context });

    case SSE_V2_EVENTS.SOURCES_ADDED: {
      // The run's set, and — for a tool call's frame — that call's own list,
      // folded the same way (the server builds the stored set likewise).
      run = { ...run, sources: mergeSources(run.sources, data) };
      if (data.callId) {
        run = {
          ...run,
          tools: run.tools.map(t =>
            t.callId === data.callId
              ? { ...t, sources: mergeSources({ items: t.sources }, { items: data.items }).items }
              : t
          )
        };
      }
      return withRun(next, run);
    }

    case SSE_V2_EVENTS.TOOL_PROGRESS:
      return withRun(next, foldToolProgress(run, data, envelope));

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
        meta: { ...run.meta, ...rest, extra: { ...run.meta.extra, ...extra } }
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

export { SSE_V2_EVENTS as RUN_EVENTS } from '../runEvents.js';
