import { z } from 'zod';

export const groupConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        /^[a-zA-Z0-9._-]+$/,
        'Group ID can only contain letters, numbers, dots, hyphens, and underscores'
      ),
    name: z.string().min(1, 'Group name is required'),
    description: z.string().optional(),
    permissions: z
      .object({
        apps: z.array(z.string()).default([]),
        prompts: z.array(z.string()).default([]),
        models: z.array(z.string()).default([]),
        adminAccess: z.boolean().default(false)
      })
      .default({}),
    mappings: z.array(z.string()).default([]),
    inherits: z.array(z.string()).optional(),
    enabled: z.boolean().default(true)
  })
  .passthrough();

export const knownGroupKeys = Object.keys(groupConfigSchema.shape);
