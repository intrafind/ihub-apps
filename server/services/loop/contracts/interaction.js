/**
 * Interaction contract — every human touchpoint as one typed model
 * (concept §5.5). Generalizes the workflow `human` node checkpoint
 * ({id, nodeId, type, message, options, inputSchema, showData, displayData,
 * timeout, expiresAt}) and the chat `ask_user` clarification
 * ({questionId, toolCallId, question, inputType, options, allowSkip,
 * allowOther, placeholder, validation, context}).
 *
 * @module services/loop/contracts/interaction
 */
import { z } from 'zod';
import {
  INTERACTION_KINDS,
  INTERACTION_ORIGINS,
  INTERACTION_STATUSES,
  HUMAN_EVENT_KINDS,
  LEDGER_IDENTITY_MODES
} from '../../../../shared/runEvents.js';

const ts = z.string().datetime({ offset: true });

export const interactionKindSchema = z.enum(INTERACTION_KINDS);
export const interactionOriginSchema = z.enum(INTERACTION_ORIGINS);
export const interactionStatusSchema = z.enum(INTERACTION_STATUSES);
export const humanEventKindSchema = z.enum(HUMAN_EVENT_KINDS);

/** Selectable option, superset of HumanNodeExecutor options and ask_user options. */
export const interactionOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** Visual hint used by HumanCheckpoint ('primary' | 'danger' | 'secondary' …). */
  style: z.string().optional()
});

/** Input widget types (client vocabulary; ask_user's server names are mapped onto these). */
export const interactionInputTypeSchema = z.enum([
  'text',
  'single_select',
  'multi_select',
  'confirm',
  'number',
  'date',
  'date_range',
  'file',
  'form'
]);

export const interactionValidationSchema = z.object({
  pattern: z.string().max(200).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  message: z.string().max(200).optional()
});

/** What is shown to the human. */
export const interactionPromptSchema = z.object({
  message: z.string(),
  title: z.string().optional(),
  inputType: interactionInputTypeSchema.default('text'),
  options: z.array(interactionOptionSchema).optional(),
  /** JSON schema for structured answers (human node `inputSchema`). */
  inputSchema: z.record(z.any()).nullable().optional(),
  /** Variable paths to display (human node `showData`). */
  showData: z.array(z.string()).nullable().optional(),
  /** Resolved values for `showData`, or an arbitrary payload for `review`. */
  displayData: z.record(z.any()).optional(),
  allowSkip: z.boolean().default(false),
  allowOther: z.boolean().default(false),
  placeholder: z.string().max(200).optional(),
  validation: interactionValidationSchema.optional(),
  /** Short context the model supplied with the question. */
  context: z.string().max(500).optional()
});

/** Behavior with no human attached / on expiry. */
export const interactionPolicySchema = z.object({
  approverGroups: z.array(z.string()).optional(),
  expiresAt: ts.nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  /** 'fail' | 'deny' | 'branch:<value>' */
  onTimeout: z
    .string()
    .regex(/^(fail|deny|branch:.+)$/)
    .default('fail'),
  /** 'park' | 'deny' | 'default:<value>' */
  fallback: z
    .string()
    .regex(/^(park|deny|default:.+)$/)
    .default('park'),
  /** Optional escalation channels for parked interactions. */
  notify: z.array(z.enum(['email', 'teams', 'webhook'])).optional()
});

export const interactionAnswerSchema = z.object({
  /** Primary answer: the chosen option value, free text, or a decision keyword. */
  value: z.any(),
  /** Structured payload (form data, edited tool args, reviewer comments). */
  data: z.record(z.any()).optional(),
  /** Decision for approvals: approve | edit | reject | respond. */
  decision: z.enum(['approve', 'edit', 'reject', 'respond']).optional(),
  reason: z.string().optional(),
  skipped: z.boolean().optional(),
  by: z.string(),
  at: ts,
  channel: z.enum(['chat', 'run_page', 'queue', 'api', 'system', 'headless']).default('api')
});

/** Where the interaction originated (for routing the answer back). */
export const interactionSourceSchema = z.object({
  toolCallId: z.string().optional(),
  toolId: z.string().optional(),
  nodeId: z.string().optional(),
  nodeName: z.string().optional(),
  executionId: z.string().optional(),
  chatId: z.string().optional(),
  appId: z.string().optional(),
  profileId: z.string().optional(),
  /** Legacy checkpoint id for the workflow `human` node bridge. */
  checkpointId: z.string().optional(),
  /** Owner of the run (its ledger principal id) and the identity mode it was recorded in. */
  principalId: z.string().optional(),
  identityMode: z.enum(LEDGER_IDENTITY_MODES).optional(),
  /** The run is anonymous: whoever holds the run and interaction ids may answer (as for the run itself). */
  anonymous: z.boolean().optional()
});

export const interactionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  step: z.number().int().nonnegative().default(0),
  kind: interactionKindSchema,
  origin: interactionOriginSchema,
  prompt: interactionPromptSchema,
  policy: interactionPolicySchema.default({}),
  status: interactionStatusSchema.default('pending'),
  source: interactionSourceSchema.default({}),
  createdAt: ts,
  updatedAt: ts.optional(),
  answer: interactionAnswerSchema.optional(),
  /** Sequence number within the run (n-th interaction) — clarification caps key off it. */
  ordinal: z.number().int().positive().optional(),
  /** Set while a worker is answering the interaction (see InteractionService.answer). */
  claim: z.object({ pid: z.number().int(), at: ts }).optional()
});

/** Body of POST /api/runs/:runId/interactions/:id/answer */
export const interactionAnswerRequestSchema = z
  .object({
    value: z.any().optional(),
    data: z.record(z.any()).optional(),
    decision: z.enum(['approve', 'edit', 'reject', 'respond']).optional(),
    reason: z.string().max(2000).optional(),
    skipped: z.boolean().optional()
  })
  .refine(
    body =>
      body.skipped === true ||
      body.value !== undefined ||
      body.data !== undefined ||
      body.decision !== undefined ||
      body.reason !== undefined,
    { message: 'An answer needs a value, data, decision or reason — or skipped: true' }
  );

/** Body of POST /api/runs/:runId/human-events (`answer` goes through the answer endpoint). */
export const humanEventRequestSchema = z
  .object({
    kind: z.enum(['steer', 'stop', 'feedback']),
    message: z.string().max(4000).optional(),
    messageId: z.string().max(200).optional(),
    rating: z.union([z.number(), z.string().max(50)]).optional()
  })
  .superRefine((body, ctx) => {
    if (body.kind === 'steer' && !(typeof body.message === 'string' && body.message.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message'],
        message: 'A steer event needs a non-empty message'
      });
    }
  });

/** A human→agent event delivered into a run (steer / stop / feedback). */
export const humanEventSchema = z.object({
  kind: humanEventKindSchema,
  runId: z.string().min(1),
  message: z.string().optional(),
  messageId: z.string().optional(),
  rating: z.union([z.number(), z.string()]).optional(),
  by: z.string(),
  at: ts
});
