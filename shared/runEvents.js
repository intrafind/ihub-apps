// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Shared vocabulary for the unified runtime ("one agentic loop").
 *
 * Imported by both server (RunLog ledger, SSE v2 projection) and client (the
 * single event reducer) so event names never drift between the two sides.
 * Keep this file dependency-free and side-effect-free.
 *
 * @module shared/runEvents
 */

/** Kinds of runs recorded in the ledger. */
export const RUN_KINDS = Object.freeze([
  'chat',
  'workflow',
  'agent',
  'subagent',
  'inference',
  'utility',
  'diagnostic'
]);

/** Terminal / lifecycle statuses of a run or loop invocation. */
export const RUN_STATUSES = Object.freeze([
  'running',
  'completed',
  'paused',
  'aborted',
  'error',
  'budget_exhausted'
]);

/**
 * The knowledge source of an answer that drew on nothing but the model itself
 * ("Based on AI knowledge"). A chat turn names it in `run/ended.knowledgeSources`
 * like any other source, so the answer badge only ever shows what the server
 * reported: a turn that reported no sources gets no badge.
 */
export const MODEL_KNOWLEDGE_SOURCE = 'llm';

/**
 * Where an answer that hit the model's output limit ran out
 * (`run/ended.limitReachedIn`): `reasoning` — the thinking used it all and no
 * answer was written; `answer` — the answer was cut off.
 */
export const LIMIT_REACHED_IN = Object.freeze(['reasoning', 'answer']);

/**
 * The kinds of source an answer can be based on (`run/ended.answerBasis`), in
 * the order the footer's chip names them. `model` stands alone: nothing was used.
 */
export const ANSWER_BASIS_KINDS = Object.freeze([
  'project',
  'web',
  'ifinder',
  'iassistant',
  'documents',
  'integration',
  'email',
  'file',
  'audio',
  'model'
]);

/**
 * Where a tool call looked (`tool/started.activityOrigin`, `Source.origin.kind`):
 * the answer-basis kinds a call to a tool can have. `email`, `file`, `audio`
 * and `model` are inputs or the fallback of a turn, never a call.
 */
export const ACTIVITY_ORIGINS = Object.freeze([
  'project',
  'web',
  'ifinder',
  'iassistant',
  'documents',
  'integration'
]);

/** The rows a tool call can make in the chat (`tool/started.activityKind`). */
export const ACTIVITY_KINDS = Object.freeze(['search', 'fetch', 'tool']);

/** Who brought a skill into a turn (`skill.activation` `activatedBy`), strongest first. */
export const SKILL_ACTIVATORS = Object.freeze(['user', 'app', 'model', 'chat']);

/** RunLog (ledger) event types — one append-only JSONL stream per run. */
export const RUN_LOG_EVENTS = Object.freeze({
  RUN_START: 'run/start',
  RUN_END: 'run/end',
  RUN_PAUSED: 'run/paused',
  RUN_RESUMED: 'run/resumed',
  SEGMENT_START: 'segment/start',
  REQUEST_HEADER: 'request/header',
  REQUEST_RETRY: 'request/retry',
  MESSAGE_USER: 'message/user',
  MESSAGE_ASSISTANT: 'message/assistant',
  TOOL_CALL: 'tool/call',
  TOOL_RESULT: 'tool/result',
  TOOL_DISABLED: 'tool/disabled',
  INTERACTION_RAISED: 'interaction/raised',
  INTERACTION_ANSWERED: 'interaction/answered',
  HUMAN_EVENT: 'human/event',
  BUDGET_CHECKPOINT: 'budget/checkpoint',
  BUDGET_EXHAUSTED: 'budget/exhausted',
  CONTEXT_COMPACTION: 'context/compaction',
  /** What a tool call, a model adapter or provider search found (`shared/sources`). */
  SOURCES_ADDED: 'sources/added',
  /** Which projects a turn reached, and whether each was loaded in full or searched (#1036). */
  KNOWLEDGE_SCOPE: 'knowledge/scope',
  ERROR: 'error'
});

export const RUN_LOG_EVENT_LIST = Object.freeze(Object.values(RUN_LOG_EVENTS));

/** SSE v2 event types — a projection of RunLog events plus transport frames. */
export const SSE_V2_EVENTS = Object.freeze({
  STREAM_CONNECTED: 'stream/connected',
  STREAM_ERROR: 'stream/error',
  RUN_STARTED: 'run/started',
  RUN_ENDED: 'run/ended',
  RUN_PAUSED: 'run/paused',
  RUN_RESUMED: 'run/resumed',
  STEP_DELTA: 'step/delta',
  STEP_COMPLETED: 'step/completed',
  TOOL_STARTED: 'tool/started',
  TOOL_PROGRESS: 'tool/progress',
  TOOL_COMPLETED: 'tool/completed',
  SOURCES_ADDED: 'sources/added',
  KNOWLEDGE_SCOPE: 'knowledge/scope',
  /** How full the model's context window is, as the server counts it (live; not stored). */
  CONTEXT_USAGE: 'context/usage',
  /**
   * The loop condensed or shortened earlier tool results to free context
   * (#3819): `running` while a findings digest is being written, `completed`
   * once the transcript changed. Projected from the ledger's `context/compaction`.
   */
  CONTEXT_COMPACTED: 'context/compacted',
  INTERACTION_RAISED: 'interaction/raised',
  INTERACTION_ANSWERED: 'interaction/answered',
  PROGRESS_NODE: 'progress/node',
  META: 'meta',
  /** A message the person sent into the running answer is queued (`services/loop/steering.js`). */
  STEER_QUEUED: 'steer/queued',
  /** A queued message was read at a step (`step`), or sent as the next turn (`nextRunId`). */
  STEER_APPLIED: 'steer/applied',
  /** A queued message will never be read (`reason`); the client gives its text back. */
  STEER_DROPPED: 'steer/dropped'
});

export const SSE_V2_EVENT_LIST = Object.freeze(Object.values(SSE_V2_EVENTS));

/** Kinds of `step/delta` payloads. */
export const STEP_DELTA_KINDS = Object.freeze(['text', 'thinking', 'image']);

/** Interaction kinds (every human touchpoint is one of these). */
export const INTERACTION_KINDS = Object.freeze(['question', 'approval', 'review', 'notify']);

/** Where an interaction was raised from. */
export const INTERACTION_ORIGINS = Object.freeze(['tool', 'node', 'policy', 'system']);

/** Interaction lifecycle. */
export const INTERACTION_STATUSES = Object.freeze(['pending', 'answered', 'expired', 'cancelled']);

/**
 * The kinds of message the person can send into a running answer (`human-events`,
 * `kind: 'steer'`, field `mode`): read at the next step, or sent after the answer.
 */
export const STEER_MODES = Object.freeze(['steer', 'afterwards']);

/** The kinds of a queued message in the chat read model (`pending[].kind`) and the frames. */
export const PENDING_MESSAGE_KINDS = Object.freeze(['steer', 'send_after']);

/**
 * Why a queued message will never be read (`steer/dropped.reason`):
 * `expired` — not read within its lifetime; `queue_full` — the oldest of more than
 * twenty; `removed` — the person removed it; `run_paused` — the answer stopped for a
 * question or an approval; `run_stopped` — the answer was stopped; `run_failed` — the
 * answer ended with an error; `superseded` — a newer message replaced the answer;
 * `temporary_chat` — the answer ended in a temporary or guest chat, where the server
 * starts no next turn; `run_ended` — the answer ended where nothing starts a next turn
 * (an API run); `not_started` — the next turn could not be started.
 */
export const STEER_DROP_REASONS = Object.freeze([
  'expired',
  'queue_full',
  'removed',
  'run_paused',
  'run_stopped',
  'run_failed',
  'superseded',
  'temporary_chat',
  'run_ended',
  'not_started'
]);

/** Human→agent events that ride the same rails as answers. */
export const HUMAN_EVENT_KINDS = Object.freeze(['answer', 'steer', 'stop', 'feedback']);

/** Identity modes for the ledger (concept §10.3). */
export const LEDGER_IDENTITY_MODES = Object.freeze(['full', 'default', 'pseudonymized']);

/** Header carrying the SSE v2 protocol version on stream endpoints. */
export const SSE_V2_PROTOCOL_VERSION = 2;
