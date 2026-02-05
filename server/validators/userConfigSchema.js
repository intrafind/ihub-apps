import { z } from 'zod';

export const userConfigSchema = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
    email: z.string().email().nullish(), // Allow null, undefined, or valid email
    fullName: z.string().nullish(),
    groups: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
    lastLogin: z.string().datetime().nullish(),
    createdAt: z.string().datetime().nullish(),
    settings: z.record(z.any()).nullish(),
    // For local auth users
    password: z.string().nullish(),
    passwordHash: z.string().nullish(),
    // For external auth users
    externalId: z.string().nullish(),
    provider: z.string().nullish()
  })
  .passthrough();

export const knownUserKeys = Object.keys(userConfigSchema.shape);
