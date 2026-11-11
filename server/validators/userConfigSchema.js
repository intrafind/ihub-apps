// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { usageLimitsSchema } from './common.js';

export const userConfigSchema = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
    email: z.string().email().nullish(), // Allow null, undefined, or valid email
    fullName: z.string().nullish(),
    groups: z.array(z.string()).prefault([]),
    enabled: z.boolean().prefault(true),
    lastLogin: z.string().datetime().nullish(),
    createdAt: z.string().datetime().nullish(),
    settings: z.record(z.any()).nullish(),
    // For local auth users
    password: z.string().nullish(),
    passwordHash: z.string().nullish(),
    // For external auth users
    externalId: z.string().nullish(),
    provider: z.string().nullish(),
    // Personal token and file storage limits (services/quota).
    usageLimits: usageLimitsSchema.optional(),
    // AI-use acknowledgements (#3326), one entry per confirmed version.
    aiAcknowledgements: z
      .array(
        z.object({
          version: z.number().int().min(1),
          textHash: z.string(),
          acknowledgedAt: z.string(),
          language: z.string().optional()
        })
      )
      .optional()
  })
  .passthrough();

export const knownUserKeys = Object.keys(userConfigSchema.shape);
