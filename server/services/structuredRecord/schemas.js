import { z } from 'zod';

/**
 * Structured-record schema registry.
 *
 * Named, versioned Zod schemas for the `extraction.data` payload of a record
 * produced by `collectStructuredRecord`. Workflow nodes declare which schema
 * their per-document prompt is expected to emit; the collector validates the
 * LLM output against the named schema before building the record envelope.
 *
 * Schema names are stable identifiers (`stellungnahmenReview`, `corpusAnalysis`)
 * paired with a semver-like version string (`v1`). Additions are additive —
 * a `v2` of a schema lives alongside `v1`; existing workflows keep working.
 *
 * The registry is generic; the named schemas it ships with happen to be
 * audit-flavored, but new consumers can register their own without touching
 * `services/auditQuotes/`.
 *
 * @module services/structuredRecord/schemas
 */

const demandedChangeSchema = z.object({
  paragraphReference: z.string().optional(),
  summary: z.string().min(1),
  sourceQuote: z.string().optional()
});

export const stellungnahmenReviewV1 = z.object({
  organisation: z.string().min(1, 'organisation is required'),
  title: z.string().min(1, 'title is required'),
  demandedChanges: z.array(demandedChangeSchema).default([])
});

export const corpusAnalysisV1 = z.object({
  keyStatements: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  position: z.string().optional(),
  evidenceQuotes: z.array(z.string()).default([])
});

const REGISTRY = {
  'stellungnahmenReview/v1': stellungnahmenReviewV1,
  'corpusAnalysis/v1': corpusAnalysisV1
};

/**
 * Look up an extraction schema by name and version.
 *
 * @param {string} schemaName
 * @param {string} schemaVersion
 * @returns {import('zod').ZodTypeAny}
 * @throws {Error} when the schema is not registered
 */
export function getExtractionSchema(schemaName, schemaVersion) {
  const key = `${schemaName}/${schemaVersion}`;
  const schema = REGISTRY[key];
  if (!schema) {
    const available = Object.keys(REGISTRY).join(', ');
    throw new Error(
      `Unknown extraction schema '${key}'. Registered schemas: ${available || '(none)'}`
    );
  }
  return schema;
}

export function listExtractionSchemas() {
  return Object.keys(REGISTRY);
}

export default { getExtractionSchema, listExtractionSchemas };
