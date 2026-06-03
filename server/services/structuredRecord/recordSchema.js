import { z } from 'zod';

/**
 * Structured Record Schema
 *
 * One record per (document × analysis step) inside a workflow run. Most
 * fields are generic; `quotes` is optional and carries audit-quote
 * payloads for workflows that use the `quote-validator` node — non-audit
 * workflows leave it empty.
 *
 * `data` is free-shape and validated by the structured-record node's
 * inline `schema` config (JSON Schema). This file only validates the
 * outer envelope.
 *
 * @module services/structuredRecord/recordSchema
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

export const sourceSchema = z.object({
  docId: z.string().min(1, 'Source docId is required'),
  sourceSystem: z.enum(['ifinder', 'upload', 'url', 'inbox']),
  title: z.string().optional(),
  url: z.string().url().optional(),
  retrievedAt: z.string().datetime().optional()
});

export const failureSchema = z.object({
  code: z.string(),
  message: z.string()
});

export const structuredRecordSchema = z.object({
  recordId: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  iterationIndex: z.number().int().nonnegative().optional(),
  source: sourceSchema,
  data: z.record(z.unknown()),
  quotes: z.array(quoteSchema).default([]),
  status: z.enum(['ok', 'partial', 'failed']).default('ok'),
  failures: z.array(failureSchema).default([])
});

export default structuredRecordSchema;
