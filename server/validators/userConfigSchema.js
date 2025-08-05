import { z } from 'zod';

export const userConfigSchema = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
    email: z.string().email().optional(),
    fullName: z.string().optional(),
    groups: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
    lastLogin: z.string().datetime().optional(),
    createdAt: z.string().datetime().optional(),
    settings: z.record(z.any()).optional(),
    // For local auth users
    password: z.string().optional(),
    passwordHash: z.string().optional(),
    // For external auth users
    externalId: z.string().optional(),
    provider: z.string().optional()
  })
  .passthrough();

export const knownUserKeys = Object.keys(userConfigSchema.shape);
