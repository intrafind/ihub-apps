// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';

/**
 * The record of the EU AI Act master switch (`contents/config/eu-ai-act-conformity.json`).
 *
 * The file is a dedicated store, not part of platform.json: the generic admin
 * save rewrites platform.json whole from client copies and applies `IHUB_*`
 * overrides, and neither may flip the switch or erase who did it and why.
 * `services/euAiAct/conformity.js` is the only reader and writer.
 */

export const MIN_DISABLE_REASON = 20;
export const MAX_REASON = 1000;
export const MAX_HISTORY = 100;
/** Version of the legal-responsibility statement the admin accepted. */
export const STATEMENT_VERSION = 1;

const iso = z.string().datetime({ offset: false });

export const actorSchema = z
  .object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) })
  .strict();

const reason = z.string().max(MAX_REASON);

export const historyEntrySchema = z
  .object({
    enabled: z.boolean(),
    changedAt: iso,
    changedBy: actorSchema,
    reason: reason.nullish(),
    statementVersion: z.number().int().min(1).nullish()
  })
  .strict();

/** The stored document. `enabled: true` with an empty history is the shipped default. */
export const euAiActConformitySchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    changedAt: iso.optional(),
    changedBy: actorSchema.optional(),
    reason: reason.nullish(),
    statementVersion: z.number().int().min(1).nullish(),
    history: z.array(historyEntrySchema).max(MAX_HISTORY)
  })
  .strict();

/** `POST .../conformity/_disable`: a reason of 20-1000 characters and the acceptance. */
export const disableBodySchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(MIN_DISABLE_REASON, `The reason needs at least ${MIN_DISABLE_REASON} characters`)
      .max(MAX_REASON, `The reason can have at most ${MAX_REASON} characters`),
    acceptResponsibility: z.literal(true, {
      error: 'acceptResponsibility must be true to switch the EU AI Act features off'
    })
  })
  .strict();

/** `POST .../conformity/_enable`: an optional note. */
export const enableBodySchema = z
  .object({
    reason: z
      .string()
      .trim()
      .max(MAX_REASON, `The reason can have at most ${MAX_REASON} characters`)
      .optional()
  })
  .strict();
