// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Zod schema of the provenance object (`intrafind-provenance/1.0`), used by the
 * run contracts and the tests. Open on purpose (`passthrough`): later features
 * add members (media `digital_source_type`, watermark `reason`) without a
 * contract change.
 *
 * @module services/provenance/provenanceSchema
 */
import { z } from 'zod';

export const provenanceSchema = z
  .object({
    spec: z.string(),
    ai_generated: z.literal(true),
    kind: z.enum(['text', 'image', 'audio']).optional(),
    generator: z
      .object({ product: z.string(), version: z.string(), installation_id: z.string() })
      .passthrough(),
    model: z
      .object({
        id: z.string().nullable(),
        watermark: z
          .object({
            by: z.enum(['ihub', 'provider', 'none']),
            scheme: z.string().optional(),
            key_id: z.string().optional(),
            applied: z.boolean()
          })
          .passthrough()
      })
      .passthrough(),
    output_id: z.string(),
    created_at: z.string(),
    content_hash: z
      .object({ alg: z.string(), normalization: z.string(), value: z.string() })
      .passthrough()
      .optional()
  })
  .passthrough();

/**
 * The part of the object the run contracts pin: enough to know it is a
 * provenance object and which output it names. Open (`passthrough`), so the
 * wire contract does not change when the object grows a member.
 */
export const provenanceContractSchema = z
  .object({ spec: z.string(), ai_generated: z.literal(true), output_id: z.string() })
  .passthrough();
