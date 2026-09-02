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
  INTERACTION_RAISED: 'interaction/raised',
  INTERACTION_ANSWERED: 'interaction/answered',
  PROGRESS_NODE: 'progress/node',
  META: 'meta'
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

/** Human→agent events that ride the same rails as answers. */
export const HUMAN_EVENT_KINDS = Object.freeze(['answer', 'steer', 'stop', 'feedback']);

/** Identity modes for the ledger (concept §10.3). */
export const LEDGER_IDENTITY_MODES = Object.freeze(['full', 'default', 'pseudonymized']);

/** Header carrying the SSE v2 protocol version on stream endpoints. */
export const SSE_V2_PROTOCOL_VERSION = 2;
