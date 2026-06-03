import { z } from 'zod';

/**
 * Evidence Record Schema
 *
 * One Evidence record is produced per (document × analysis step) inside a
 * completeness-analysis workflow run. The record captures the structured
 * extraction emitted by the per-document LLM prompt together with the
 * provenance metadata needed for an audit-grade final report.
 *
 * `extraction.data` is intentionally free-shape (validated by extractionSchemas
 * registry against `extraction.schemaName` + `extraction.schemaVersion`). The
 * Zod schema here validates only the outer envelope.
 *
 * @module validators/evidenceRecordSchema
 */

export const quoteLocatorSchema = z
  .object({
    page: z.number().int().nonnegative().optional(),
    section: z.string().optional()
  })
  .partial()
  .optional();

export const quoteSchema = z.object({
  text: z.string().min(1, 'Quote text cannot be empty'),
  locator: quoteLocatorSchema,
  validated: z.boolean().default(false),
  closestMatch: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional()
});

export const evidenceSourceSchema = z.object({
  docId: z.string().min(1, 'Source docId is required'),
  sourceSystem: z.enum(['ifinder', 'upload', 'url', 'inbox']),
  title: z.string().optional(),
  url: z.string().url().optional(),
  retrievedAt: z.string().datetime().optional()
});

export const evidenceFailureSchema = z.object({
  code: z.string(),
  message: z.string()
});

export const evidenceLlmMetadataSchema = z
  .object({
    model: z.string().optional(),
    promptHash: z.string().optional(),
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional()
  })
  .partial()
  .optional();

export const evidenceClassificationSchema = z
  .object({
    type: z.string().optional(),
    sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']).optional(),
    labels: z.array(z.string()).optional(),
    score: z.number().min(0).max(1).optional()
  })
  .partial()
  .optional();

export const evidenceExtractionSchema = z.object({
  schemaName: z.string().min(1, 'extraction.schemaName is required'),
  schemaVersion: z.string().min(1, 'extraction.schemaVersion is required'),
  data: z.record(z.unknown())
});

export const evidenceRecordSchema = z.object({
  evidenceId: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  iterationIndex: z.number().int().nonnegative().optional(),
  source: evidenceSourceSchema,
  extraction: evidenceExtractionSchema,
  quotes: z.array(quoteSchema).default([]),
  classification: evidenceClassificationSchema,
  llm: evidenceLlmMetadataSchema,
  status: z.enum(['ok', 'partial', 'failed']).default('ok'),
  failures: z.array(evidenceFailureSchema).default([])
});

export default evidenceRecordSchema;
