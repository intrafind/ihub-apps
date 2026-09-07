/**
 * LoopRequest / LoopResult contracts for `AgentLoop.run()` and the request
 * shape of `LLMClient.execute()` (concept §5.2 / §5.3).
 *
 * @module services/loop/contracts/loop
 */
import { z } from 'zod';
import { RUN_KINDS, RUN_STATUSES } from '../../../../shared/runEvents.js';
import { usageSchema, principalSchema, toolCallRecordSchema } from './runLogEvents.js';
import { interactionSchema } from './interaction.js';

/** A tool as offered to the model (provider-agnostic generic tool). */
export const toolSpecSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    parameters: z.record(z.any()).optional(),
    /** Passthrough tools stream their own result to the client and end the turn. */
    passthrough: z.boolean().optional(),
    /** Read-only tools may always run in parallel (segment planner). */
    readOnly: z.boolean().optional(),
    /** Tools that raise a `question` interaction instead of executing. */
    interactive: z.boolean().optional()
  })
  .passthrough();

export const budgetPoliciesSchema = z.object({
  /** 0 = unlimited. Run-level token spend across every step/node. */
  maxTokensPerRun: z.number().int().nonnegative().default(0),
  /** Hard cap on tool rounds per loop invocation. */
  maxToolRounds: z.number().int().positive().default(10),
  /** Wall-clock deadline for one invocation, suspended while paused. */
  maxWallClockMs: z.number().int().positive().optional()
});

export const toolPoliciesSchema = z.object({
  maxRateLimitFailures: z.number().int().positive().default(2),
  maxConsecutiveFailures: z.number().int().positive().default(3),
  /** Run independent tool calls of one assistant turn concurrently. */
  parallel: z.boolean().default(true),
  maxParallel: z.number().int().positive().default(4),
  /** Apply schema defaults to omitted arguments. */
  applyDefaults: z.boolean().default(true)
});

export const contextPoliciesSchema = z.object({
  compactThresholdTokens: z.number().int().positive().default(16000),
  compactKeepRecent: z.number().int().nonnegative().default(6),
  maxReactiveAttempts: z.number().int().nonnegative().default(2),
  reactiveKeepRecent: z.number().int().nonnegative().default(4),
  /** Bytes above which tool results are spilled to disk and previewed in the transcript. */
  spillThresholdBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024)
});

export const interactionPoliciesSchema = z.object({
  maxQuestions: z.number().int().nonnegative().default(10),
  /** Whether a raised question pauses the run (durable) or ends the turn (legacy chat). */
  pauseOnQuestion: z.boolean().default(true),
  questionTimeoutMs: z.number().int().positive().optional(),
  headlessFallback: z.enum(['park', 'deny', 'fail']).default('park')
});

export const approvalPoliciesSchema = z.object({
  /** Tool ids requiring an `approval` interaction before execution. */
  requireApprovalFor: z.array(z.string()).default([]),
  approverGroups: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  onTimeout: z.enum(['deny', 'fail']).default('deny')
});

export const loopPoliciesSchema = z.object({
  budgets: budgetPoliciesSchema.default({}),
  tools: toolPoliciesSchema.default({}),
  context: contextPoliciesSchema.default({}),
  interactions: interactionPoliciesSchema.default({}),
  approval: approvalPoliciesSchema.default({})
});

/** Provider-facing call options (the allowlist formerly in adapterOptions.js). */
export const llmCallOptionsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    responseFormat: z.string().nullable().optional(),
    responseSchema: z.record(z.any()).nullable().optional(),
    toolChoice: z.any().optional(),
    thinkingEnabled: z.boolean().optional(),
    thinkingBudget: z.number().optional(),
    thinkingThoughts: z.boolean().optional(),
    thinkingLevel: z.string().optional(),
    nativeWebSearch: z.any().nullable().optional(),
    imageConfig: z.record(z.any()).nullable().optional(),
    stream: z.boolean().optional()
  })
  .passthrough();

/** Telemetry / ledger binding for one LLMClient call. */
export const llmTelemetrySchema = z.object({
  runId: z.string().optional(),
  kind: z.enum(RUN_KINDS).optional(),
  step: z.number().int().nonnegative().optional(),
  segment: z.string().optional(),
  purpose: z.string().optional(),
  chatId: z.string().optional(),
  appId: z.string().optional(),
  executionId: z.string().optional(),
  userId: z.string().optional(),
  principal: z.any().optional()
});

/** Request accepted by `LLMClient.execute()`. */
export const llmRequestSchema = z.object({
  /** Either a model id (resolved via configCache) or a full model config. */
  model: z.union([z.string().min(1), z.record(z.any())]),
  messages: z.array(z.any()).min(1),
  tools: z.array(toolSpecSchema).optional(),
  apiKey: z.string().nullable().optional(),
  options: llmCallOptionsSchema.default({}),
  telemetry: llmTelemetrySchema.default({}),
  language: z.string().default('en'),
  /** Max transient retries; defaults to the client's configured value. */
  maxRetries: z.number().int().nonnegative().optional()
});

export const loopRequestSchema = z.object({
  runId: z.string().optional(),
  kind: z.enum(RUN_KINDS).default('chat'),
  parentRunId: z.string().optional(),
  principal: principalSchema.partial({ mode: true }).optional(),
  model: z.union([z.string().min(1), z.record(z.any())]),
  messages: z.array(z.any()).min(1),
  tools: z.array(toolSpecSchema).default([]),
  /** 'server' executes tools; 'caller' terminates with tool_calls and never executes. */
  toolExecution: z.enum(['server', 'caller']).default('server'),
  policies: loopPoliciesSchema.default({}),
  options: llmCallOptionsSchema.default({}),
  language: z.string().default('en'),
  /** Free-form correlation refs (chatId, appId, executionId, nodeId, profileId …). */
  refs: z.record(z.any()).default({}),
  /** Resume from a paused step (interaction answered). */
  resume: z
    .object({
      interactionId: z.string(),
      step: z.number().int().nonnegative(),
      completedCallIds: z.array(z.string()).default([])
    })
    .optional()
});

export const citationSchema = z
  .object({
    url: z.string().optional(),
    title: z.string().optional(),
    source: z.string().optional(),
    toolId: z.string().optional(),
    taskId: z.string().nullable().optional()
  })
  .passthrough();

export const loopResultSchema = z.object({
  runId: z.string(),
  status: z.enum(RUN_STATUSES),
  content: z.string().default(''),
  structured: z.any().optional(),
  finishReason: z.string().nullable().default(null),
  usage: usageSchema,
  runUsage: usageSchema.optional(),
  iterations: z.number().int().nonnegative(),
  citations: z.array(citationSchema).default([]),
  /** Present when toolExecution === 'caller' and the model requested tools. */
  toolCalls: z.array(toolCallRecordSchema).optional(),
  thoughtSignatures: z.array(z.any()).optional(),
  pendingInteraction: interactionSchema.optional(),
  disabledTools: z.array(z.string()).default([]),
  budgetExhausted: z.boolean().default(false),
  /** Final provider-valid transcript (for callers that persist it or continue). */
  messages: z.array(z.any()).default([]),
  knowledgeSources: z.array(z.string()).default([]),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      providerCode: z.string().nullable().optional()
    })
    .optional()
});
