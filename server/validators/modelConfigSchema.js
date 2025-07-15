import { z } from 'zod';

export const modelConfigSchema = z
  .object({
    id: z.string(),
    modelId: z.string(),
    name: z.record(z.string()),
    description: z.record(z.string()),
    url: z.string(),
    provider: z.string(),
    tokenLimit: z.number(),
    default: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    concurrency: z.number().optional(),
    requestDelayMs: z.number().optional(),
    enabled: z.boolean().optional()
  })
  .passthrough();

export const knownModelKeys = Object.keys(modelConfigSchema.shape);
