/**
 * RunLog event contracts — the ledger underneath every chat, workflow, agent
 * and inference run (concept §5.4). One append-only JSONL stream per run.
 *
 * Rule: anything model-visible must be reconstructable from the log. The
 * `request/header` event therefore carries the exact call configuration and a
 * hash of the rendered tool schemas / messages, and `tool/call` is logged
 * BEFORE execution so a crash mid-tool is visible.
 *
 * These schemas are the spec. `server/tests/loop/contracts.test.js` snapshots
 * their JSON-schema export so contract drift is a failing test.
 *
 * @module services/loop/contracts/runLogEvents
 */
import { z } from 'zod';
import {
  RUN_KINDS,
  RUN_STATUSES,
  RUN_LOG_EVENTS,
  LEDGER_IDENTITY_MODES
} from '../../../../shared/runEvents.js';
import { interactionSchema, interactionAnswerSchema, humanEventSchema } from './interaction.js';

export const runKindSchema = z.enum(RUN_KINDS);
export const runStatusSchema = z.enum(RUN_STATUSES);
export const identityModeSchema = z.enum(LEDGER_IDENTITY_MODES);

/** Canonical usage buckets (concept §5.2 "usage normalization"). */
export const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  /** 'provider' when the numbers came from the provider, 'estimate' when estimated locally. */
  source: z.enum(['provider', 'estimate', 'mixed']).optional()
});

/**
 * The actor recorded on a run. Fields beyond `id` are present only in
 * identity mode `full`; in `pseudonymized` mode `id` is a salted hash.
 */
export const principalSchema = z.object({
  id: z.string().min(1),
  mode: identityModeSchema,
  anonymous: z.boolean().default(false),
  isAgent: z.boolean().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  groups: z.array(z.string()).optional(),
  /** Agent profile id when the principal is an agent run. */
  profileId: z.string().optional()
});

/** A tool call as recorded on the ledger (provider-agnostic). */
export const toolCallRecordSchema = z.object({
  id: z.string().nullable(),
  index: z.number().int().nonnegative().optional(),
  type: z.string().default('function'),
  name: z.string(),
  /** Raw JSON string as produced by the model (may be malformed). */
  arguments: z.string().default(''),
  /** Provider-specific metadata (e.g. Gemini thoughtSignature). */
  metadata: z.record(z.any()).optional()
});

/** Reference to a spilled (large) payload stored outside the ledger line. */
export const spillRefSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().optional(),
  contentType: z.string().optional()
});

const ts = z.string().datetime({ offset: true });

// ── Event payloads ─────────────────────────────────────────────────────────

export const runStartData = z.object({
  kind: runKindSchema,
  parentRunId: z.string().optional(),
  principal: principalSchema,
  trigger: z
    .object({
      type: z.enum(['user', 'api', 'schedule', 'webhook', 'tool', 'system', 'test']),
      source: z.string().optional()
    })
    .default({ type: 'user' }),
  /** Surface-specific correlation ids (never PII). */
  refs: z
    .object({
      chatId: z.string().optional(),
      appId: z.string().optional(),
      executionId: z.string().optional(),
      workflowId: z.string().optional(),
      profileId: z.string().optional(),
      nodeId: z.string().optional(),
      requestId: z.string().optional()
    })
    .default({}),
  model: z.string().optional(),
  language: z.string().optional(),
  policies: z.record(z.any()).optional()
});

export const runEndData = z.object({
  status: runStatusSchema,
  finishReason: z.string().nullable().default(null),
  usage: usageSchema.optional(),
  cost: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      providerCode: z.string().nullable().optional()
    })
    .optional()
});

export const runPausedData = z.object({
  reason: z.enum(['interaction', 'manual', 'system']),
  interactionId: z.string().optional(),
  step: z.number().int().nonnegative().optional(),
  /** Wall-clock at pause so budgets can suspend deadlines. */
  pausedAt: ts.optional()
});

export const runResumedData = z.object({
  interactionId: z.string().optional(),
  step: z.number().int().nonnegative().optional(),
  pausedMs: z.number().int().nonnegative().optional()
});

/**
 * A segment groups the calls of one loop invocation or one purpose-tagged
 * auxiliary call (compaction summarizer, title generation, verifier scoring)
 * bound to the same runId (concept §5.1).
 */
export const segmentStartData = z.object({
  segment: z.string(),
  purpose: z.string(),
  parentSegment: z.string().optional(),
  supersedes: z.string().optional()
});

export const requestHeaderData = z.object({
  step: z.number().int().nonnegative(),
  segment: z.string().optional(),
  purpose: z.string().optional(),
  requestId: z.string(),
  model: z.string(),
  provider: z.string(),
  modelId: z.string().optional(),
  /** Hash of the exact provider request body (after adapter formatting). */
  requestHash: z.string(),
  /** SHA-256 over the model-visible messages array (pre-adapter). */
  messagesHash: z.string(),
  messageCount: z.number().int().nonnegative(),
  /** Full messages are recorded on 'initial' and 'change', omitted on 'same' (hash-dedupe, concept §8.3). */
  reason: z.enum(['initial', 'change', 'same']),
  messages: z.array(z.any()).optional(),
  renderedSystemPrompt: z.string().optional(),
  toolSchemasHash: z.string().nullable(),
  toolSchemas: z.array(z.any()).optional(),
  toolExecution: z.enum(['server', 'caller', 'none']).default('none'),
  callConfig: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().int().optional(),
      responseFormat: z.string().nullable().optional(),
      responseSchemaHash: z.string().nullable().optional(),
      /** Full schema, recorded when it first appears on the run and whenever its hash changes. */
      responseSchema: z.any().optional(),
      thinking: z.record(z.any()).nullable().optional(),
      nativeWebSearch: z.any().nullable().optional(),
      toolChoice: z.any().optional(),
      stream: z.boolean().default(true)
    })
    .default({}),
  language: z.string().optional()
});

export const requestRetryData = z.object({
  step: z.number().int().nonnegative(),
  requestId: z.string(),
  attempt: z.number().int().positive(),
  code: z.string(),
  status: z.number().int().nullable().optional(),
  delayMs: z.number().int().nonnegative()
});

export const messageUserData = z.object({
  step: z.number().int().nonnegative(),
  messageId: z.string().optional(),
  content: z.string().default(''),
  attachments: z
    .array(
      z.object({ type: z.string(), name: z.string().optional(), bytes: z.number().optional() })
    )
    .optional(),
  /** Set when this user message was injected by the system (wrap-up nudge, steer). */
  synthetic: z.enum(['nudge', 'steer', 'system']).optional()
});

export const messageAssistantData = z.object({
  step: z.number().int().nonnegative(),
  requestId: z.string().optional(),
  messageId: z.string().optional(),
  content: z.string().default(''),
  contentSpill: spillRefSchema.optional(),
  toolCalls: z.array(toolCallRecordSchema).default([]),
  thinkingChars: z.number().int().nonnegative().optional(),
  usage: usageSchema.optional(),
  finishReason: z.string().nullable().default(null),
  hasImages: z.boolean().optional(),
  groundingMetadata: z.any().optional()
});

export const toolCallData = z.object({
  step: z.number().int().nonnegative(),
  callId: z.string(),
  toolId: z.string(),
  name: z.string(),
  args: z.any(),
  argsRepaired: z.boolean().optional(),
  /** Execution class decided by the segment planner. */
  execution: z.enum(['server', 'caller', 'clarification', 'passthrough']).default('server'),
  parallelGroup: z.number().int().nonnegative().optional()
});

export const toolResultData = z.object({
  step: z.number().int().nonnegative(),
  callId: z.string(),
  toolId: z.string(),
  name: z.string(),
  resultPreview: z.any(),
  resultBytes: z.number().int().nonnegative().optional(),
  spillRef: spillRefSchema.optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string(),
      rateLimited: z.boolean().optional()
    })
    .optional(),
  durationMs: z.number().int().nonnegative(),
  hasImage: z.boolean().optional(),
  knowledgeSource: z.string().optional()
});

export const toolDisabledData = z.object({
  step: z.number().int().nonnegative(),
  toolId: z.string(),
  reason: z.enum(['rate_limited', 'repeated_failures', 'policy']),
  failures: z.number().int().nonnegative(),
  lastMessage: z.string().optional()
});

export const interactionRaisedData = z.object({
  interaction: interactionSchema
});

export const interactionAnsweredData = z.object({
  interactionId: z.string(),
  kind: z.string(),
  answer: interactionAnswerSchema
});

/** A human→agent event (steer / stop / feedback) recorded on the run. */
export const humanEventData = humanEventSchema.omit({ runId: true });

export const budgetLimitsSchema = z.object({
  maxTokensPerRun: z.number().int().nonnegative().optional(),
  maxToolRounds: z.number().int().nonnegative().optional(),
  maxQuestions: z.number().int().nonnegative().optional()
});

export const budgetCheckpointData = z.object({
  step: z.number().int().nonnegative(),
  usage: usageSchema,
  runUsage: usageSchema,
  limits: budgetLimitsSchema.default({})
});

export const budgetExhaustedData = z.object({
  step: z.number().int().nonnegative(),
  reason: z.enum(['tokens', 'rounds', 'tools_dead', 'questions']),
  runUsage: usageSchema.optional(),
  limits: budgetLimitsSchema.default({})
});

export const contextCompactionData = z.object({
  step: z.number().int().nonnegative(),
  trigger: z.enum(['proactive', 'overflow']),
  collapsed: z.number().int().nonnegative(),
  freedChars: z.number().int().nonnegative(),
  shadowedRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  summaryRef: spillRefSchema.optional()
});

export const errorData = z.object({
  step: z.number().int().nonnegative().optional(),
  code: z.string(),
  message: z.string(),
  providerCode: z.string().nullable().optional(),
  status: z.number().int().nullable().optional(),
  recoverable: z.boolean().default(false)
});

// ── Envelope + discriminated union ─────────────────────────────────────────

const base = {
  seq: z.number().int().nonnegative(),
  ts,
  runId: z.string().min(1)
};

export const runLogEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.RUN_START), data: runStartData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.RUN_END), data: runEndData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.RUN_PAUSED), data: runPausedData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.RUN_RESUMED), data: runResumedData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.SEGMENT_START), data: segmentStartData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.REQUEST_HEADER), data: requestHeaderData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.REQUEST_RETRY), data: requestRetryData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.MESSAGE_USER), data: messageUserData }),
  z.object({
    ...base,
    type: z.literal(RUN_LOG_EVENTS.MESSAGE_ASSISTANT),
    data: messageAssistantData
  }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.TOOL_CALL), data: toolCallData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.TOOL_RESULT), data: toolResultData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.TOOL_DISABLED), data: toolDisabledData }),
  z.object({
    ...base,
    type: z.literal(RUN_LOG_EVENTS.INTERACTION_RAISED),
    data: interactionRaisedData
  }),
  z.object({
    ...base,
    type: z.literal(RUN_LOG_EVENTS.INTERACTION_ANSWERED),
    data: interactionAnsweredData
  }),
  z.object({
    ...base,
    type: z.literal(RUN_LOG_EVENTS.BUDGET_CHECKPOINT),
    data: budgetCheckpointData
  }),
  z.object({
    ...base,
    type: z.literal(RUN_LOG_EVENTS.BUDGET_EXHAUSTED),
    data: budgetExhaustedData
  }),
  z.object({
    ...base,
    type: z.literal(RUN_LOG_EVENTS.CONTEXT_COMPACTION),
    data: contextCompactionData
  }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.HUMAN_EVENT), data: humanEventData }),
  z.object({ ...base, type: z.literal(RUN_LOG_EVENTS.ERROR), data: errorData })
]);

/** Map of event type → data schema, for validating a payload before appending. */
export const runLogEventDataSchemas = Object.freeze({
  [RUN_LOG_EVENTS.RUN_START]: runStartData,
  [RUN_LOG_EVENTS.RUN_END]: runEndData,
  [RUN_LOG_EVENTS.RUN_PAUSED]: runPausedData,
  [RUN_LOG_EVENTS.RUN_RESUMED]: runResumedData,
  [RUN_LOG_EVENTS.SEGMENT_START]: segmentStartData,
  [RUN_LOG_EVENTS.REQUEST_HEADER]: requestHeaderData,
  [RUN_LOG_EVENTS.REQUEST_RETRY]: requestRetryData,
  [RUN_LOG_EVENTS.MESSAGE_USER]: messageUserData,
  [RUN_LOG_EVENTS.MESSAGE_ASSISTANT]: messageAssistantData,
  [RUN_LOG_EVENTS.TOOL_CALL]: toolCallData,
  [RUN_LOG_EVENTS.TOOL_RESULT]: toolResultData,
  [RUN_LOG_EVENTS.TOOL_DISABLED]: toolDisabledData,
  [RUN_LOG_EVENTS.INTERACTION_RAISED]: interactionRaisedData,
  [RUN_LOG_EVENTS.INTERACTION_ANSWERED]: interactionAnsweredData,
  [RUN_LOG_EVENTS.BUDGET_CHECKPOINT]: budgetCheckpointData,
  [RUN_LOG_EVENTS.BUDGET_EXHAUSTED]: budgetExhaustedData,
  [RUN_LOG_EVENTS.CONTEXT_COMPACTION]: contextCompactionData,
  [RUN_LOG_EVENTS.HUMAN_EVENT]: humanEventData,
  [RUN_LOG_EVENTS.ERROR]: errorData
});

/**
 * Validate an event payload for `type`. Throws a ZodError on mismatch.
 * @param {string} type
 * @param {*} data
 * @returns {*} parsed data (defaults applied)
 */
export function parseRunLogEventData(type, data) {
  const schema = runLogEventDataSchemas[type];
  if (!schema) throw new Error(`Unknown RunLog event type: ${type}`);
  return schema.parse(data);
}
