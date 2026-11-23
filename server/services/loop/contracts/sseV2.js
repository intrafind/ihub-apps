// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * SSE v2 event contracts — one typed schema, a projection of RunLog events
 * plus transport frames (concept §5.6). Every envelope carries a per-run
 * sequence number so the client reducer can detect relay gaps and re-sync
 * from `GET /api/runs/:runId/events?cursor=<c>`.
 *
 * @module services/loop/contracts/sseV2
 */
import { z } from 'zod';
import {
  SSE_V2_EVENTS,
  STEP_DELTA_KINDS,
  RUN_STATUSES,
  RUN_KINDS,
  ACTIVITY_ORIGINS
} from '../../../../shared/runEvents.js';
import {
  usageSchema,
  toolCallRecordSchema,
  sourcesAddedData,
  knowledgeScopeData,
  answerBasisSchema,
  limitReachedInSchema,
  abortCauseSchema,
  placeSchema,
  compactionKindsSchema
} from './runLogEvents.js';
import { MAX_PLACES } from '../../../../shared/run/places.js';
import { interactionSchema, interactionAnswerSchema } from './interaction.js';
import { provenanceContractSchema } from '../../provenance/provenanceSchema.js';

const ts = z.string().datetime({ offset: true });

export const streamConnectedData = z.object({
  runId: z.string().optional(),
  /** Last sequence number the server has for this run (0 when new). */
  lastSeq: z.number().int().nonnegative().prefault(0),
  protocol: z.literal(2).prefault(2),
  /**
   * On a chat turn's own POST stream: whether the turn outlives the connection
   * (a kept chat) or ends with it (a temporary one). Decided by the server.
   */
  durable: z.boolean().optional()
});

/**
 * The cause of a failed model call, decided on the server
 * (`services/chat/chatErrors.js`) with the keys of the admin model test
 * (`certificateUntrusted`, `serverError`, `apiKeyRequired`, …). The client
 * translates `failureCause`; it never infers one. `host` and `errorCode` are
 * sent to an administrator only.
 */
export const failureCauseFields = {
  failureCause: z.string().max(64).optional(),
  /** HTTP status the model endpoint answered with. */
  upstreamStatus: z.number().int().optional(),
  /** Host (and port) that was called; administrators only. */
  host: z.string().max(255).optional(),
  /** Socket or certificate code (e.g. `SELF_SIGNED_CERT_IN_CHAIN`); administrators only. */
  errorCode: z.string().max(64).optional()
};

export const streamErrorData = z.object({
  code: z.string(),
  message: z.string(),
  details: z.any().optional(),
  /** True when the client may retry the whole turn. */
  retryable: z.boolean().prefault(false),
  isContextWindowError: z.boolean().optional(),
  ...failureCauseFields
});

export const runStartedData = z.object({
  kind: z.enum(RUN_KINDS),
  parentRunId: z.string().optional(),
  model: z.string().optional(),
  refs: z.record(z.any()).prefault({})
});

/**
 * How full the model's context window is, counted by the server: the prompt
 * the provider reported for the last model call plus what the transcript grew
 * by since (the reply, tool results such as pages a research read).
 */
export const contextUsageData = z.object({
  contextWindow: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative().prefault(0),
  /** `provider`: anchored on the provider's count; `estimate`: counted by the server. */
  source: z.enum(['provider', 'estimate']).prefault('estimate'),
  /** The system prompt's share of `inputTokens` (a turn's end only): the next turn replaces it. */
  systemTokens: z.number().int().nonnegative().optional(),
  /** The model the figure was counted for (a turn's end only). */
  modelId: z.string().optional(),
  step: z.number().int().nonnegative().optional()
});

/** Characters of a digest a `context/compacted` frame carries (the activity row shows it). */
export const MAX_COMPACTION_DIGEST_CHARS = 8000;

/**
 * Earlier tool results were condensed (a findings digest) or shortened (lossy)
 * to free context (#3819). The server says what happened; the chat renders it.
 */
export const contextCompactedData = z.object({
  compactionId: z.string().min(1),
  step: z.number().int().nonnegative().prefault(0),
  status: z.enum(['running', 'completed']),
  trigger: z.enum(['proactive', 'overflow', 'manual']).prefault('proactive'),
  /** `digest`: condensed into notes; `elide`: collapsed to previews. */
  strategy: z.enum(['digest', 'elide']).optional(),
  /** Data was dropped rather than condensed. */
  lossy: z.boolean().prefault(false),
  fallbackReason: z.string().max(200).optional(),
  /** Still near the window after condensing: the turn stops searching and answers from the notes. */
  wrapUp: z.boolean().optional(),
  tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(),
  /** Tool results condensed or shortened. */
  itemsSummarised: z.number().int().nonnegative().prefault(0),
  kinds: compactionKindsSchema.optional(),
  /** The digest (bounded to {@link MAX_COMPACTION_DIGEST_CHARS}). */
  digest: z
    .string()
    .max(MAX_COMPACTION_DIGEST_CHARS + 20)
    .optional(),
  digestTruncated: z.boolean().optional(),
  facts: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional()
});

/**
 * The `context/compacted` frame of a compaction: from the ledger's
 * `context/compaction` data (re-sync) or the loop's `onCompaction` info (live),
 * which carry the same fields. `status` defaults to `completed`.
 *
 * @param {Object} info
 * @param {'running'|'completed'} [status='completed']
 * @returns {Object}
 */
export function compactedFrameOf(info, status = 'completed') {
  const d = info || {};
  const digest = typeof d.digest === 'string' ? d.digest : undefined;
  const truncated = digest !== undefined && digest.length > MAX_COMPACTION_DIGEST_CHARS;
  const int = value => (Number.isInteger(value) && value >= 0 ? value : undefined);
  return {
    compactionId: String(d.compactionId),
    step: int(d.step) ?? 0,
    status,
    trigger: ['proactive', 'overflow', 'manual'].includes(d.trigger) ? d.trigger : 'proactive',
    ...(d.strategy === 'digest' || d.strategy === 'elide' ? { strategy: d.strategy } : {}),
    lossy: d.lossy === true,
    ...(typeof d.fallbackReason === 'string' && d.fallbackReason
      ? { fallbackReason: d.fallbackReason.slice(0, 200) }
      : {}),
    ...(d.wrapUp === true ? { wrapUp: true } : {}),
    ...(int(d.tokensBefore) !== undefined ? { tokensBefore: int(d.tokensBefore) } : {}),
    ...(int(d.tokensAfter) !== undefined ? { tokensAfter: int(d.tokensAfter) } : {}),
    itemsSummarised: int(d.itemsSummarised) ?? int(d.collapsed) ?? 0,
    ...(d.kinds && typeof d.kinds === 'object'
      ? {
          kinds: {
            search: int(d.kinds.search) ?? 0,
            fetch: int(d.kinds.fetch) ?? 0,
            tool: int(d.kinds.tool) ?? 0
          }
        }
      : {}),
    ...(digest !== undefined
      ? {
          digest: truncated ? `${digest.slice(0, MAX_COMPACTION_DIGEST_CHARS)}…` : digest,
          ...(truncated || d.digestTruncated === true ? { digestTruncated: true } : {})
        }
      : {}),
    ...(int(d.facts) !== undefined ? { facts: int(d.facts) } : {}),
    ...(int(d.durationMs) !== undefined ? { durationMs: int(d.durationMs) } : {})
  };
}

export const runEndedData = z.object({
  status: z.enum(RUN_STATUSES),
  finishReason: z.string().nullable().prefault(null),
  usage: usageSchema.optional(),
  /** The context window's state when the run ended. */
  context: contextUsageData.optional(),
  /** Surface hints preserved from the legacy `done` event. */
  toolName: z.string().optional(),
  knowledgeSources: z.array(z.string()).optional(),
  /** What the answer is based on: the kinds of source it used (chat turns). */
  answerBasis: answerBasisSchema.optional(),
  /** Where the answer ran out when it hit the output limit (chat turns). */
  limitReachedIn: limitReachedInSchema.optional(),
  /** Provenance of the answer (EU AI Act Art. 50(2)); chat turns with text. */
  provenance: provenanceContractSchema.optional(),
  /** Workflow output (chat-visible result) when the run produced one. */
  output: z.any().optional(),
  /** Set when the run was aborted: who stopped it, from where and when. */
  cause: abortCauseSchema.optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string(), ...failureCauseFields })
    .optional()
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
      /**
       * Provenance object of the picture (EU AI Act Art. 50(2), #3328): the
       * spec-shaped object of a text answer with `kind: image` and the hash of
       * the raw bytes.
       */
      provenance: provenanceContractSchema.optional(),
      thoughtSignature: z.string().optional()
    })
    .optional(),
  /** Thinking metadata (signature etc.) when kind === 'thinking'. */
  meta: z.record(z.any()).optional()
});

export const stepCompletedData = z.object({
  step: z.number().int().nonnegative(),
  messageId: z.string().optional(),
  content: z.string().prefault(''),
  toolCalls: z.array(toolCallRecordSchema).prefault([]),
  finishReason: z.string().nullable().prefault(null),
  usage: usageSchema.optional(),
  sources: z.array(z.string()).optional(),
  groundingMetadata: z.any().optional()
});

/**
 * The MCP App view a tool renders (extension `io.modelcontextprotocol/ui`):
 * which MCP server and `ui://` resource to draw it from.
 */
const mcpAppRefSchema = z.object({
  serverId: z.string(),
  toolName: z.string(),
  resourceUri: z.string()
});

/**
 * A finished MCP App view: the reference plus the data it is drawn from —
 * tool input and the full CallToolResult — unless the payload was too large
 * to ship (`payloadOmitted`).
 */
export const mcpAppViewSchema = mcpAppRefSchema.extend({
  callId: z.string(),
  toolId: z.string(),
  args: z.record(z.string(), z.any()).optional(),
  toolResult: z.record(z.string(), z.any()).optional(),
  cancelled: z.boolean().optional(),
  payloadOmitted: z.boolean().optional(),
  /**
   * The tool declares no view; the view is the `ui://` page embedded in
   * `toolResult` under `resourceUri`, never read with `resources/read`.
   */
  embedded: z.boolean().optional()
});

export const toolStartedData = z.object({
  step: z.number().int().nonnegative(),
  callId: z.string(),
  toolId: z.string(),
  name: z.string(),
  /** The action as the user reads it ("Search people"), when the tool names one. */
  title: z.string().optional(),
  /** The integration, MCP server or remote agent the call ran against ("Munich AD"). */
  integration: z.string().optional(),
  /** The row the chat draws (server `utils/toolDisplay`): a search, a page/document read or a plain call. */
  activityKind: z.enum(['search', 'fetch', 'tool']).optional(),
  /**
   * Where the call looked, in the footer's vocabulary (server `utils/toolDisplay`:
   * `activityOriginOf`); absent when the server cannot place the call. Never
   * inferred from the tool id by the client.
   */
  activityOrigin: z.enum(ACTIVITY_ORIGINS).optional(),
  /** What the call found is on the open web (a shipped web search engine): a share keeps its hits. */
  publicHits: z.literal(true).optional(),
  args: z.any(),
  execution: z.enum(['server', 'caller', 'clarification', 'passthrough']).prefault('server'),
  mcpApp: mcpAppRefSchema.optional()
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
  knowledgeSource: z.string().optional(),
  /** Origin that only the result tells (the recall of earlier sources); see `toolStartedData`. */
  activityOrigin: z.enum(ACTIVITY_ORIGINS).optional(),
  /** Hits a search returned, `0` included; absent when the server does not know. Never inferred from `sources/added`. */
  resultCount: z.number().int().nonnegative().optional(),
  /** What a page or document read delivered: `opened` (text) or `empty` (completed, no text). */
  readOutcome: z.enum(['opened', 'empty']).optional(),
  /** Where the call looked: the projects or the search profile, by name (`shared/run/places.js`). */
  places: z.array(placeSchema).max(MAX_PLACES).optional(),
  /** MCP App view drawn from this call's full result. */
  mcpApp: mcpAppViewSchema.optional(),
  /**
   * The call's integration needs the caller to connect (or reconnect) first
   * (`INTEGRATION_AUTH_REQUIRED`, returned before the call ran): the chat
   * shows the Connect card for it and retries the call once after a connect.
   */
  authRequired: z
    .object({
      integration: z.string(),
      name: z.string(),
      reason: z.enum(['not_connected', 'expired', 'insufficient_scope']),
      action: z.string().optional(),
      scopes: z.array(z.string()).optional()
    })
    .optional(),
  /**
   * A scheduled task a scheduling tool proposed: the chat shows a confirmation
   * card for it, and nothing is saved until the user confirms there.
   */
  scheduledTaskProposal: z
    .object({
      proposalId: z.string(),
      action: z.enum(['create', 'update', 'delete']),
      taskId: z.string().optional(),
      draft: z.record(z.any()).optional(),
      summary: z.record(z.any()).optional()
    })
    .optional(),
  /**
   * Files a system skill tool generated for the user (a PDF, Word document
   * or presentation from `create_pdf`, `create_docx`, `create_pptx`): the
   * chat shows a download card for each. In a stored chat the file is an
   * artifact of the chat already (`stored: true`, `id` is the artifact's), and
   * the card fetches it from the artifact route when it is opened. Only a file
   * that could not be stored (no chat store, artifacts turned off, over the
   * size cap) carries its bytes, base64, in `data`. The model's tool result
   * never carries them.
   */
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        mimeType: z.string(),
        bytes: z.number().int().nonnegative(),
        pages: z.number().int().positive().optional(),
        slides: z.number().int().positive().optional(),
        sheets: z.number().int().positive().optional(),
        stored: z.literal(true).optional(),
        data: z.string().optional()
      })
    )
    .optional()
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
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.SOURCES_ADDED), data: sourcesAddedData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.KNOWLEDGE_SCOPE), data: knowledgeScopeData }),
  z.object({ ...base, type: z.literal(SSE_V2_EVENTS.CONTEXT_USAGE), data: contextUsageData }),
  z.object({
    ...base,
    type: z.literal(SSE_V2_EVENTS.CONTEXT_COMPACTED),
    data: contextCompactedData
  }),
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
  [SSE_V2_EVENTS.SOURCES_ADDED]: sourcesAddedData,
  [SSE_V2_EVENTS.KNOWLEDGE_SCOPE]: knowledgeScopeData,
  [SSE_V2_EVENTS.CONTEXT_USAGE]: contextUsageData,
  [SSE_V2_EVENTS.CONTEXT_COMPACTED]: contextCompactedData,
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
