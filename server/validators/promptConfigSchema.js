import { z } from 'zod';

export const promptConfigSchema = z
  .object({
    id: z.string(),
    name: z.record(z.string()),
    description: z.record(z.string()).optional(),
    prompt: z.record(z.string()),
    category: z.string().optional(),
    order: z.number().optional(),
    enabled: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    variables: z
      .array(
        z.object({
          name: z.string(),
          type: z.enum(['string', 'number', 'boolean', 'date', 'select', 'textarea']).optional(),
          required: z.boolean().optional(),
          default: z.any().optional(),
          options: z.array(z.string()).optional(),
          description: z.record(z.string()).optional()
        })
      )
      .optional()
  })
  .passthrough();

export const knownPromptKeys = Object.keys(promptConfigSchema.shape);
