import { z } from 'zod';
import { HEX_COLOR_PATTERN, LANGUAGE_CODE_PATTERN } from '../../shared/validationPatterns.js';

const AGENT_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*[a-z0-9]$/;
const AGENT_PROFILE_ID_MAX_LENGTH = 64;

const localizedStringSchema = z.record(
  z.string().regex(LANGUAGE_CODE_PATTERN, 'Invalid language code'),
  z.string().min(1, 'Localized string cannot be empty')
);

// Embedded workflow definition is intentionally permissive; the workflow
// validator validates the full shape when the engine starts.
// The Profile may omit `workflow.definition` entirely — the
// profileWorkflowSerializer fills in a default shape on save based on the
// Profile's `system`/`tools`/`sources`/`apps`/`preferredModel`/Planner/
// Dynamic-Tasks settings. For `external` refs `workflowId` is required.
const workflowRefSchema = z
  .object({
    ref: z.enum(['embedded', 'external']).optional().default('embedded'),
    workflowId: z.string().optional(),
    definition: z
      .object({
        nodes: z.array(z.any()).optional(),
        edges: z.array(z.any()).optional(),
        triggers: z.array(z.any()).optional()
      })
      .passthrough()
      .optional()
  })
  .refine(
    data => {
      if (data.ref === 'external') {
        return typeof data.workflowId === 'string' && data.workflowId.length > 0;
      }
      return true;
    },
    { message: 'external workflow requires a workflowId' }
  );

const memorySchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    autoInclude: z.boolean().optional().default(true),
    maxBytes: z.number().int().min(0).max(1_000_000).optional().default(8192)
  })
  .strict();

const hitlSchema = z
  .object({
    approverGroups: z.array(z.string()).optional().default([])
  })
  .strict();

const plannerSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    maxTasks: z.number().int().min(1).max(50).optional().default(10)
  })
  .strict();

const dynamicTasksSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    maxDepth: z.number().int().min(0).max(10).optional().default(3)
  })
  .strict();

const budgetsSchema = z
  .object({
    maxWallTimeSec: z.number().int().min(10).max(86_400).optional().default(600)
  })
  .strict();

const concurrencySchema = z
  .object({
    maxConcurrent: z.number().int().min(1).max(10).optional().default(1)
  })
  .strict();

const artifactsSchema = z
  .object({
    outputDir: z.string().optional().default('auto'),
    primary: z.string().optional().default('report.md')
  })
  .strict();

const serviceAccountSchema = z
  .object({
    groups: z.array(z.string()).optional().default(['agents', 'authenticated'])
  })
  .strict();

const baseAgentProfileSchema = z.object({
  id: z
    .string()
    .regex(
      AGENT_PROFILE_ID_PATTERN,
      'Profile ID must be lowercase alphanumeric (hyphens/underscores allowed)'
    )
    .min(1)
    .max(AGENT_PROFILE_ID_MAX_LENGTH),
  name: localizedStringSchema,
  description: localizedStringSchema.optional(),
  color: z
    .string()
    .regex(HEX_COLOR_PATTERN, 'Color must be a valid hex code (e.g. #6366F1)')
    .optional()
    .default('#6366F1'),
  icon: z.string().min(1).optional().default('robot'),

  workflow: workflowRefSchema.optional().default({}),

  // ── Agent brief: what it is, what model + capabilities it gets ──────────
  // These are convenience fields on the Profile. The profileWorkflowSerializer
  // propagates them into every prompt node in the default workflow. Authors
  // who hand-author `workflow.definition` can still override per-node.
  system: localizedStringSchema.optional(),
  preferredModel: z.string().optional(),
  preferredTemperature: z.number().min(0).max(2).optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  tools: z.array(z.string()).optional().default([]),
  sources: z.array(z.string()).optional().default([]),
  apps: z.array(z.string()).optional().default([]),

  memory: memorySchema.optional().default({}),
  inboxId: z.string().optional(),
  hitl: hitlSchema.optional().default({}),
  planner: plannerSchema.optional().default({}),
  dynamicTasks: dynamicTasksSchema.optional().default({}),
  budgets: budgetsSchema.optional().default({}),
  concurrency: concurrencySchema.optional().default({}),
  artifacts: artifactsSchema.optional().default({}),

  groups: z.array(z.string()).optional().default([]),
  serviceAccount: serviceAccountSchema.optional().default({}),

  enabled: z.boolean().optional().default(true),
  order: z.number().int().min(0).optional()
});

export const knownAgentProfileKeys = Object.keys(baseAgentProfileSchema.shape);

export const agentProfileSchema = baseAgentProfileSchema.strict();

export { AGENT_PROFILE_ID_PATTERN, AGENT_PROFILE_ID_MAX_LENGTH };
