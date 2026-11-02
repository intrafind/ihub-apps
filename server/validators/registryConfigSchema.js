// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
import semver from 'semver';

/** The key of a pin: `<type>:<name>` of a catalog item (`integration:org.ckan__open-data-portal`). */
export const PIN_KEY_PATTERN =
  /^(app|model|prompt|skill|workflow|integration):[A-Za-z0-9._-]{1,100}$/;

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
  auth: registryAuthSchema.optional().prefault({ type: 'none' }),
  /** Whether this registry participates in marketplace browsing */
  enabled: z.boolean().prefault(true),
  /** Whether the server should periodically re-fetch this registry's catalog */
  autoRefresh: z.boolean().prefault(false),
  /** How often (in hours) to auto-refresh when autoRefresh is enabled (1–168) */
  refreshIntervalHours: z.number().int().min(1).max(168).optional().prefault(24),
  /**
   * Whether integrations from this registry may bring code that runs in the
   * server process (`script` protocol). Off by default: the admin grants it to
   * registries whose publisher they trust, such as the IntraFind registry.
   */
  trustCode: z.boolean().prefault(false),
  /**
   * Which versions of the catalog this server is offered (versioning phase
   * 3): `stable` (absent reads as stable) offers no pre-release version
   * (`2.0.0-rc.1`), `all` every version the catalog lists.
   */
  channel: z.enum(['stable', 'all']).optional(),
  /**
   * Per-item version pins, keyed `<type>:<name>` like the installation
   * manifest (`integration:org.ckan__open-data-portal`), each a semver range
   * (`1.3.x`, `~1.3.0`, `<2`). Install and the update badge offer only
   * versions inside the pin.
   */
  pins: z
    .record(
      z.string().regex(PIN_KEY_PATTERN, 'a pin is keyed <type>:<name>'),
      z
        .string()
        .trim()
        .min(1)
        .max(100)
        .refine(range => semver.validRange(range, { includePrerelease: true }) !== null, {
          message: 'a pin is a semver range such as 1.3.x, ~1.3.0 or <2'
        })
    )
    .optional()
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
    errors: result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`)
  };
}

/**
 * Validate only the version policy of a registry config (`channel`, `pins`),
 * as an edit of an existing registry does: the rest of a stored registry is
 * not re-validated on edit.
 *
 * @param {unknown} data - the registry config (other fields are ignored)
 * @returns {{ success: true, data: { channel?: string, pins?: Record<string, string> } } | { success: false, errors: string[] }}
 */
export function validateRegistryVersionPolicy(data) {
  const result = registryConfigSchema
    .pick({ channel: true, pins: true })
    .safeParse({ channel: data?.channel, pins: data?.pins });
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`)
  };
}
