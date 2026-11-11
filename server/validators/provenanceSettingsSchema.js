// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Zod schema of `platform.provenance` as the admin form sends it, with the
 * bounds of `shared/provenanceSettings.js`. Every key is optional (a partial
 * body leaves the stored value alone); unknown keys pass through. A watermark
 * tunable of `null` removes the key (the code default applies again).
 *
 * @module validators/provenanceSettingsSchema
 */
import { z } from 'zod';
import { PROVENANCE_BOUNDS, VERIFY_ACCESS_VALUES } from '../../shared/provenanceSettings.js';

const B = PROVENANCE_BOUNDS;

export const provenanceSettingsSaveSchema = z
  .object({
    retentionDays: z.number().int().min(B.retentionDays.min).max(B.retentionDays.max).optional(),
    storeRecords: z.boolean().optional(),
    verify: z
      .object({ access: z.enum(VERIFY_ACCESS_VALUES).optional() })
      .passthrough()
      .optional(),
    media: z
      .object({
        maxVerifyBytes: z
          .number()
          .int()
          .min(B.maxVerifyBytes.min)
          .max(B.maxVerifyBytes.max)
          .optional(),
        readC2pa: z.boolean().optional()
      })
      .passthrough()
      .optional(),
    watermark: z
      .object({
        alpha: z.number().gt(B.alpha.min).lt(B.alpha.max).nullable().optional(),
        minScoredTokens: z
          .number()
          .int()
          .min(B.minScoredTokens.min)
          .max(B.minScoredTokens.max)
          .nullable()
          .optional(),
        detectorTimeoutMs: z
          .number()
          .int()
          .min(B.detectorTimeoutMs.min)
          .max(B.detectorTimeoutMs.max)
          .nullable()
          .optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();
