/**
 * Registry Config Schema
 *
 * Validates the configuration object for a marketplace registry entry stored
 * in config/registries.json. A registry points to a remote catalog.json and
 * may optionally require authentication.
 *
 * @module validators/registryConfigSchema
 */

import { z } from 'zod';

/**
 * Authentication strategies for accessing a registry endpoint.
 * Uses a discriminated union so the shape is enforced per auth type.
 */
const registryAuthSchema = z.discriminatedUnion('type', [
  /** No authentication required (public registry) */
  z.object({ type: z.literal('none') }),
  /** Bearer token authentication (e.g. GitHub PAT) */
  z.object({ type: z.literal('bearer'), token: z.string() }),
  /** HTTP Basic authentication */
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  /** Custom header authentication (e.g. X-API-Key) */
  z.object({ type: z.literal('header'), headerName: z.string(), headerValue: z.string() })
]);

/**
 * Full registry configuration object as stored in config/registries.json.
 */
export const registryConfigSchema = z.object({
  /**
   * Unique machine-readable identifier for this registry.
   * Must be lowercase alphanumeric with hyphens (URL-safe slug).
   */
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  /** Human-readable registry name shown in the admin UI */
  name: z.string().min(1).max(200),
  /** Optional description of what this registry contains */
  description: z.string().optional(),
  /** URL pointing to the registry's catalog.json (or its parent directory) */
  source: z.string().url(),
  /** Authentication configuration; defaults to none (public) */
  auth: registryAuthSchema.optional().default({ type: 'none' }),
  /** Whether this registry participates in marketplace browsing */
  enabled: z.boolean().default(true),
  /** Whether the server should periodically re-fetch this registry's catalog */
  autoRefresh: z.boolean().default(false),
  /** How often (in hours) to auto-refresh when autoRefresh is enabled (1–168) */
  refreshIntervalHours: z.number().int().min(1).max(168).optional().default(24)
});

/**
 * Validate a registry configuration object.
 *
 * @param {unknown} data - Raw data to validate (e.g. from request body or JSON file)
 * @returns {{ success: true, data: object } | { success: false, errors: string[] }}
 *
 * @example
 * const result = validateRegistryConfig(req.body);
 * if (!result.success) {
 *   return res.status(400).json({ errors: result.errors });
 * }
 */
export function validateRegistryConfig(data) {
  const result = registryConfigSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
  };
}
