// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { SAFE_ID_PATTERN } from '../utils/pathSecurity.js';

export const zSafeId = z
  .string()
  .regex(
    SAFE_ID_PATTERN,
    'ID must contain only alphanumeric characters, underscores, dots, and hyphens'
  );

/**
 * Whether `value` parses as an absolute URL with the `http:` or `https:` scheme.
 *
 * `z.string().url()` on its own accepts any scheme `new URL()` can parse,
 * including `javascript:` and `data:`.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A URL string limited to the `http:` and `https:` schemes. Use it for URLs the
 * client navigates to or renders as a link or frame, so a configured value can
 * only ever point at a web page.
 *
 * @param {string} [label='URL'] - Field name used in the validation messages.
 * @returns {import('zod').ZodType<string>}
 *
 * @example
 * const redirectConfigSchema = z.object({ url: zHttpUrl('Redirect URL') });
 */
export const zHttpUrl = (label = 'URL') =>
  z
    .string()
    .url(`${label} must be a valid URL`)
    .refine(isHttpUrl, { message: `${label} must use http or https` });

/**
 * A token budget per reset window (`services/quota/resetSchedule.js`): a
 * number ≥ 0 is the limit (0 blocks), -1 or null is unlimited, a missing
 * window is not limited at this level.
 */
const zLimitValue = z.number().int().min(-1).nullable();

export const usageLimitBucketSchema = z
  .object({
    day: zLimitValue.optional(),
    week: zLimitValue.optional(),
    month: zLimitValue.optional()
  })
  .strict();

/**
 * Usage limits of a group or a user. They can only lower the limits of the
 * levels above (model → group → user); see `services/quota/limitResolver.js`.
 */
export const usageLimitsSchema = z
  .object({
    // Budget across all models (lowers `platform.usageLimits.allModels`).
    allModels: usageLimitBucketSchema.optional(),
    // Budget per model id; `*` applies to every model without its own entry.
    models: z.record(z.string(), usageLimitBucketSchema).optional(),
    // Uploaded file storage in bytes (lowers `uploads.quotas.maxUserBytes`).
    fileStorageBytes: zLimitValue.optional()
  })
  .strict();

/**
 * Validate `usageLimits` from an admin editor and drop empty parts.
 *
 * @param {*} value - `null` clears the limits
 * @returns {{ok: true, value: Object|null} | {ok: false, error: string}}
 */
export function parseUsageLimitsInput(value) {
  if (value === null) return { ok: true, value: null };
  const parsed = usageLimitsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `Invalid usageLimits${issue?.path?.length ? `.${issue.path.join('.')}` : ''}: ${issue?.message || 'invalid'}`
    };
  }
  const clean = bucket => {
    if (!bucket) return null;
    const out = {};
    for (const [window, limit] of Object.entries(bucket)) {
      if (limit !== undefined && limit !== null) out[window] = limit;
    }
    return Object.keys(out).length ? out : null;
  };
  const out = {};
  const allModels = clean(parsed.data.allModels);
  if (allModels) out.allModels = allModels;
  const models = {};
  for (const [modelId, bucket] of Object.entries(parsed.data.models || {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(modelId)) continue;
    const cleaned = clean(bucket);
    if (cleaned) models[modelId] = cleaned;
  }
  if (Object.keys(models).length) out.models = models;
  if (parsed.data.fileStorageBytes !== undefined && parsed.data.fileStorageBytes !== null) {
    out.fileStorageBytes = parsed.data.fileStorageBytes;
  }
  return { ok: true, value: Object.keys(out).length ? out : null };
}
