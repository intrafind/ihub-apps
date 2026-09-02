/**
 * SSE v2 event contracts — one typed schema, a projection of RunLog events
 * plus transport frames (concept §5.6). Every envelope carries a per-run
 * sequence number so the client reducer can detect relay gaps and re-sync
 * from `GET /api/runs/:runId/events?after=<seq>`.
 *
 * @module services/loop/contracts/sseV2
 */
import { z } from 'zod';
import {
  SSE_V2_EVENTS,
  STEP_DELTA_KINDS,
  RUN_STATUSES,
  RUN_KINDS
} from '../../../../shared/runEvents.js';
import { usageSchema, toolCallRecordSchema } from './runLogEvents.js';
import { interactionSchema, interactionAnswerSchema } from './interaction.js';

const ts = z.string().datetime({ offset: true });

export const streamConnectedData = z.object({
  runId: z.string().optional(),
  /** Last sequence number the server has for this run (0 when new). */
  lastSeq: z.number().int().nonnegative().default(0),
  protocol: z.literal(2).default(2)
});

export const streamErrorData = z.object({
  code: z.string(),
  message: z.string(),
  details: z.any().optional(),
  /** True when the client may retry the whole turn. */
  retryable: z.boolean().default(false),
  isContextWindowError: z.boolean().optional()
});

export const runStartedData = z.object({
  kind: z.enum(RUN_KINDS),
  parentRunId: z.string().optional(),
  model: z.string().optional(),
  refs: z.record(z.any()).default({})
});

export const runEndedData = z.object({
  status: z.enum(RUN_STATUSES),
  finishReason: z.string().nullable().default(null),
  usage: usageSchema.optional(),
  /** Surface hints preserved from the legacy `done` event. */
  toolName: z.string().optional(),
  knowledgeSources: z.array(z.string()).optional()
});

export const runPausedData = z.object({
  reason: z.enum(['interaction', 'manual', 'system']),
  interactionId: z.string().optional()
});

export const runResumedData = z.object({
  interactionId: z.string().optional()
});

export const stepDeltaData = z.object({
  step: z.number().int().nonnegative(),
  kind: z.enum(STEP_DELTA_KINDS),
  /** Text/thinking content for kind text|thinking. */
  content: z.string().optional(),
  /** Image payload for kind image. */
  image: z
    .object({
      mimeType: z.string(),
      data: z.string(),
      thoughtSignature: z.string().optional()
    })
    .optional(),
  /** Thinking metadata (signature etc.) when kind === 'thinking'. */
  meta: z.record(z.any()).optional()
});

export const stepCompletedData = z.object({
  step: z.number().int().nonnegative(),
  messageId: z.string().optional(),
  content: z.string().default(''),
  toolCalls: z.array(toolCallRecordSchema).default([]),
  finishReason: z.string().nullable().default(null),
  usage: usageSchema.optional(),
  citations: z.any().optional(),
  sources: z.array(z.string()).optional(),
  groundingMetadata: z.any().optional()
});

export const toolStartedData = z.object({
  step: z.number().int().nonnegative(),
  callId: z.string(),
  toolId: z.string(),
  name: z.string(),
  args: z.any(),
  execution: z.enum(['server', 'caller', 'clarification', 'passthrough']).default('server')
});

export const toolProgressData = z.object({
  step: z.number().int().nonnegative().optional(),
  callId: z.string().optional(),
  toolId: z.string().optional(),
  /** Free-form progress payload (search status, action message, skill activation, workflow step …). */
  phase: z.string().optional(),
  message: z.string().optional(),
  data: z.any().optional()
});

export const toolCompletedData = z.object({
  step: z.number().int().nonnegative(),
  callId: z.string(),
  toolId: z.string(),
  name: z.string(),
  resultPreview: z.any(),
  error: z.object({ code: z.string().optional(), message: z.string() }).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  knowledgeSource: z.string().optional()
});

export const interactionRaisedData = z.object({
  interaction: interactionSchema
});

export const interactionAnsweredData = z.object({
  interactionId: z.string(),
  kind: z.string(),
  answer: interactionAnswerSchema
});

export const progressNodeData = z.object({
  executionId: z.string().optional(),
  nodeId: z.string(),
  nodeName: z.string().optional(),
  nodeType: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped', 'paused', 'cancelled']),
  iteration: z.number().int().nonnegative().optional(),
  progress: z.any().optional(),
  output: z.any().optional(),
  error: z.string().optional()
});

export const metaData = z.object({
  conversationId: z.string().optional(),
  title: z.string().optional(),
  messageId: z.string().optional(),
  responseMessageId: z.string().optional(),
  chatId: z.string().optional(),
  executionId: z.string().optional(),
  /** Anything else surface-specific that is not part of the run semantics. */
  extra: z.record(z.any()).optional()
});

const base = {
  v: z.literal(2),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  ts
};

export const sseV2EventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.STREAM_CONNECTED), data: streamConnectedData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.STREAM_ERROR), data: streamErrorData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.RUN_STARTED), data: runStartedData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.RUN_ENDED), data: runEndedData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.RUN_PAUSED), data: runPausedData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.RUN_RESUMED), data: runResumedData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.STEP_DELTA), data: stepDeltaData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.STEP_COMPLETED), data: stepCompletedData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.TOOL_STARTED), data: toolStartedData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.TOOL_PROGRESS), data: toolProgressData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.TOOL_COMPLETED), data: toolCompletedData }),
  z.object({
    ...base,
    type: z.literal(SSE_V2_EVENTS.INTERACTION_RAISED),
    data: interactionRaisedData
  }),
  z.object({
    ...base,
    type: z.literal(SSE_V2_EVENTS.INTERACTION_ANSWERED),
    data: interactionAnsweredData
  }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.PROGRESS_NODE), data: progressNodeData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.META), data: metaData })
]);

export const sseV2EventDataSchemas = Object.freeze({
  [SSE_V2_EVENTS.STREAM_CONNECTED]: streamConnectedData,
  [SSE_V2_EVENTS.STREAM_ERROR]: streamErrorData,
  [SSE_V2_EVENTS.RUN_STARTED]: runStartedData,
  [SSE_V2_EVENTS.RUN_ENDED]: runEndedData,
  [SSE_V2_EVENTS.RUN_PAUSED]: runPausedData,
  [SSE_V2_EVENTS.RUN_RESUMED]: runResumedData,
  [SSE_V2_EVENTS.STEP_DELTA]: stepDeltaData,
  [SSE_V2_EVENTS.STEP_COMPLETED]: stepCompletedData,
  [SSE_V2_EVENTS.TOOL_STARTED]: toolStartedData,
  [SSE_V2_EVENTS.TOOL_PROGRESS]: toolProgressData,
  [SSE_V2_EVENTS.TOOL_COMPLETED]: toolCompletedData,
  [SSE_V2_EVENTS.INTERACTION_RAISED]: interactionRaisedData,
  [SSE_V2_EVENTS.INTERACTION_ANSWERED]: interactionAnsweredData,
  [SSE_V2_EVENTS.PROGRESS_NODE]: progressNodeData,
  [SSE_V2_EVENTS.META]: metaData
});

/**
 * Validate an SSE v2 payload for `type`. Throws a ZodError on mismatch.
 */
export function parseSseV2EventData(type, data) {
  const schema = sseV2EventDataSchemas[type];
  if (!schema) throw new Error(`Unknown SSE v2 event type: ${type}`);
  return schema.parse(data);
}
