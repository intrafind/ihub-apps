/**
 * Catalog Schema
 *
 * Validates the structure of a marketplace catalog.json file fetched from a registry.
 * A catalog describes the content items (apps, models, prompts, skills, workflows) that
 * a registry exposes for discovery and installation.
 *
 * @module validators/catalogSchema
 */

import { z } from 'zod';

/**
 * Describes where the actual content file for a catalog item lives.
 * Three source types are supported:
 * - relative: path relative to the catalog's base URL
 * - github:   GitHub repository file via the GitHub Contents API
 * - url:      absolute URL to the content file
 */
const catalogSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('relative'),
    path: z.string()
  }),
  z.object({
    type: z.literal('github'),
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    ref: z.string().optional().default('main')
  }),
  z.object({
    type: z.literal('url'),
    url: z.string().url()
  })
]);

/**
 * Describes a single installable item listed in a registry catalog.
 */
const catalogItemSchema = z.object({
  /** Discriminator for which iHub content type this item represents */
  type: z.enum(['app', 'model', 'prompt', 'skill', 'workflow']),
  /** Unique machine-readable name used as the file/directory identifier on disk */
  name: z.string().min(1).max(100),
  /** Human-readable localized display names keyed by language code */
  displayName: z.record(z.string()).optional(),
  /** Localized descriptions keyed by language code */
  description: z.record(z.string()).optional(),
  /** Semver-compatible version string */
  version: z.string().optional(),
  /** Author name or handle */
  author: z.string().optional(),
  /** Freeform category label used for UI filtering */
  category: z.string().optional(),
  /** Arbitrary tags for discovery and filtering */
  tags: z.array(z.string()).optional().default([]),
  /** How to fetch the actual content file */
  source: catalogSourceSchema,
  /** Icon identifier (e.g. emoji, icon name, or URL) */
  icon: z.string().optional(),
  /** SPDX license identifier (e.g. "MIT", "Apache-2.0") */
  license: z.string().optional(),
  /** Minimum iHub server version required to use this item */
  minVersion: z.string().optional()
});

/**
 * Top-level catalog document fetched from a registry's catalog.json endpoint.
 */
export const catalogSchema = z.object({
  /** Human-readable name for the registry catalog */
  name: z.string().optional(),
  /** Description of the registry catalog */
  description: z.string().optional(),
  /** Catalog schema version */
  version: z.string().optional(),
  /** Category names used in this catalog (informational) */
  categories: z.array(z.string()).optional().default([]),
  /** List of installable content items */
  items: z.array(catalogItemSchema).default([])
});

/**
 * Validate raw catalog data against the catalog schema.
 *
 * @param {unknown} data - Raw data to validate (parsed JSON from catalog.json)
 * @returns {{ success: true, data: object } | { success: false, errors: string[] }}
 *
 * @example
 * const result = validateCatalog(parsedJson);
 * if (!result.success) {
 *   console.error(result.errors);
 * }
 */
export function validateCatalog(data) {
  const result = catalogSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
  };
}
