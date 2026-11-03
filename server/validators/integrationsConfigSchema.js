// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { zSafeId } from './common.js';
import { APPROVAL_MODES } from '../../shared/toolApproval.js';
import {
  AUTH_MODES,
  integrationIdSchema,
  isStrictSemver,
  localizedStringSchema,
  SIDE_EFFECTS
} from './integrationDefinitionSchema.js';

/**
 * `contents/config/integrations.json`: the admin's installed integrations
 * (04-architecture §1.3). One definition can be installed several times, each
 * instance pointing at another endpoint, with its own label, values and action
 * policy. Sensitive values never land here; `auth.credentialRef` points at the
 * credential store. Which groups may use an instance is not stored here but on
 * the groups (`groups.json` → `permissions.integrations`).
 */

const instanceIdSchema = zSafeId.min(1).max(64);

const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** A `list` install field stores an array of strings. */
const valueSchema = z.union([primitiveSchema, z.array(z.string())]);

const installedAuthSchema = z.object({
  mode: z.enum(AUTH_MODES).prefault('none'),
  /** Credential-store profile holding the shared secret (service-account mode). */
  credentialRef: z.string().min(1).max(128).optional()
});

const actionOverrideSchema = z.object({
  description: localizedStringSchema.optional(),
  sideEffect: z.enum(SIDE_EFFECTS).optional()
});

const installedActionsSchema = z.object({
  /** Action names, or `["*"]` for every action the definition enables by default. */
  enabled: z.array(z.string().min(1).max(64)).prefault(['*']),
  disabled: z.array(z.string().min(1).max(64)).prefault([]),
  overrides: z.record(z.string(), actionOverrideSchema).prefault({})
});

/**
 * Tool approval of an installation (#2945): whether a person approves a call
 * before it runs. `default` applies to every action; `actions` sets a mode per
 * action, keyed by the action's own name (the MCP tool's name, never the
 * prefixed tool id). The strictest of platform default, `default`, the
 * action's mode and the app's override wins (`utils/toolApproval.js`). Absent
 * means nothing is asked on account of the installation.
 */
export const installedApprovalSchema = z.object({
  default: z.enum(APPROVAL_MODES).optional(),
  actions: z.record(z.string().min(1).max(128), z.enum(APPROVAL_MODES)).optional()
});

const healthSchema = z.object({
  status: z.enum(['ok', 'error', 'unknown']).prefault('unknown'),
  checkedAt: z.string().optional(),
  actionCount: z.number().int().optional(),
  message: z.string().nullable().optional()
});

/**
 * Where an installation stands with its definition's versions (versioning
 * concept §3). Absent is the normal state. `health.status` is a different
 * field (the last health check) and unrelated.
 *
 * - `migrationPending`: the loaded definition is newer than `definitionVersion`
 *   and a migration lies between them (derived at run time; never needs to
 *   be stored, but a stored one is accepted and re-derived).
 * - `migrationFailed`: a migration ran and failed; values and
 *   `definitionVersion` are as before it, the installation offers no tools
 *   until an admin re-runs the migration, restores a backup or uninstalls.
 * - `needsReview`: `definitionVersion` is missing or not a version, or the
 *   definition is older than it (a downgrade without a matching backup);
 *   never migrated automatically.
 */
export const INSTALLATION_STATUSES = Object.freeze([
  'migrationPending',
  'migrationFailed',
  'needsReview'
]);

/** What a migration log entry records as its outcome. */
export const MIGRATION_LOG_RESULTS = Object.freeze([
  'migrated',
  'stamped',
  'failed',
  'rolledBack',
  'restored',
  'adopted',
  'reverted'
]);

/** Entries kept in `migrationLog` (the newest last). */
export const MIGRATION_LOG_LIMIT = 10;

const migrationWarningSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(2000),
  appId: z.string().max(128).optional(),
  key: z.string().max(256).optional(),
  action: z.string().max(128).optional(),
  scope: z.string().max(256).optional()
});

/** One run of the definition migration runner (or a restore or adopt) on an installation. */
export const migrationLogEntrySchema = z.object({
  from: z.string().max(64).nullable(),
  to: z.string().max(64).nullable(),
  at: z.string().max(64),
  /** The admin (or `system` for the startup run). */
  by: z.string().max(256),
  /** What started it: `startup`, `marketplace`, `manual`, `restore`, `adopt`, `recovery`. */
  trigger: z.string().max(32).optional(),
  result: z.enum(MIGRATION_LOG_RESULTS),
  /** The migrations that ran, by id (the version each brings the installation to). */
  migrations: z.array(z.string().max(64)).max(200).prefault([]),
  /** The steps that ran, one readable line each (`1.3.0: renameValue fq → defaultFilter`). */
  steps: z.array(z.string().max(500)).max(500).prefault([]),
  warnings: z.array(migrationWarningSchema).max(200).prefault([]),
  /** What changed: install values, policy actions, app bindings. */
  changes: z
    .object({
      values: z.number().int().min(0),
      actions: z.number().int().min(0),
      apps: z.number().int().min(0)
    })
    .optional(),
  /** Why it failed (`failed`), or what was restored. */
  reason: z.string().max(4000).optional(),
  /** The backup the run made or restored (a folder of `contents/backups/integrations/`). */
  backup: z.string().max(256).optional()
});

/**
 * A stored `definitionVersion` that is not a strict version (hand-edited,
 * or written before versioning) must not make the whole file fail to load:
 * every installation would vanish with it. It is dropped here and the
 * installation is marked `needsReview` with the value in the reason, so the
 * admin sees what was there and decides (restore a backup, adopt the loaded
 * definition's version, or uninstall). Applied to every read of the file.
 *
 * @param {unknown} raw - one entry of `installed[]`, unvalidated
 * @returns {unknown}
 */
export function normalizeStoredInstallation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const stored = raw.definitionVersion;
  if (stored === undefined || stored === null || isStrictSemver(stored)) return raw;
  const rest = { ...raw };
  delete rest.definitionVersion;
  const shown = typeof stored === 'string' ? stored.slice(0, 64) : JSON.stringify(stored);
  return {
    ...rest,
    status: 'needsReview',
    statusReason: `stored definitionVersion ${JSON.stringify(shown)} is not a semantic version (MAJOR.MINOR.PATCH)`
  };
}

const installedIntegrationObjectSchema = z.object({
  id: instanceIdSchema,
  definition: integrationIdSchema,
  /** The definition version the values were last written for (strict semver). */
  definitionVersion: z
    .string()
    .refine(isStrictSemver, { message: 'definitionVersion must be a semantic version' })
    .optional(),
  /**
   * Migration state (see {@link INSTALLATION_STATUSES}); written by the
   * definition migration runner only. A value this server does not know is
   * dropped rather than failing the file.
   */
  status: z.enum(INSTALLATION_STATUSES).optional().catch(undefined),
  statusReason: z.string().max(4000).optional().catch(undefined),
  /** The last {@link MIGRATION_LOG_LIMIT} runs, oldest first; a damaged log is dropped, not fatal. */
  migrationLog: z
    .array(migrationLogEntrySchema)
    .max(MIGRATION_LOG_LIMIT)
    .optional()
    .catch(undefined),
  label: localizedStringSchema.optional(),
  description: localizedStringSchema.optional(),
  enabled: z.boolean().prefault(true),
  /** Non-sensitive install field values (a `list` field holds an array of strings). */
  values: z.record(z.string(), valueSchema).prefault({}),
  auth: installedAuthSchema.prefault({ mode: 'none' }),
  actions: installedActionsSchema.prefault({ enabled: ['*'], disabled: [], overrides: {} }),
  /** Tool approval: `{ default?, actions? }` (see {@link installedApprovalSchema}). */
  approval: installedApprovalSchema.optional(),
  // No `allowedGroups` (removed in #3093, moved onto the groups by V203): who
  // may use an installation is `groups.json` → `permissions.integrations`.
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  /** Written by health checks, never by admins. */
  health: healthSchema.optional(),
  installedAt: z.string().optional(),
  updatedAt: z.string().optional()
});

export const installedIntegrationSchema = z.preprocess(
  normalizeStoredInstallation,
  installedIntegrationObjectSchema
);

export const integrationsConfigSchema = z
  .object({
    installed: z.array(installedIntegrationSchema).prefault([]),
    security: z
      .object({
        blockPrivateIps: z.boolean().prefault(true),
        allowedHosts: z.array(z.string().min(1)).prefault([])
      })
      .prefault({ blockPrivateIps: true, allowedHosts: [] })
  })
  .superRefine((config, ctx) => {
    const seen = new Set();
    config.installed.forEach((inst, i) => {
      if (seen.has(inst.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['installed', i, 'id'],
          message: `duplicate instance id "${inst.id}"`
        });
      }
      seen.add(inst.id);
    });
  });

/**
 * Validate the whole config file.
 * @param {unknown} data
 * @returns {{ success: true, data: object } | { success: false, errors: Array }}
 */
export function validateIntegrationsConfig(data) {
  const result = integrationsConfigSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: result.error.issues };
}

/**
 * Validate one instance (admin create/update payload).
 * @param {unknown} data
 */
export function validateInstalledIntegration(data) {
  const result = installedIntegrationSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: result.error.issues };
}

export default integrationsConfigSchema;
