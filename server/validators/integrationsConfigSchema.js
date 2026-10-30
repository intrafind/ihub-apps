// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { zSafeId } from './common.js';
import {
  AUTH_MODES,
  integrationIdSchema,
  localizedStringSchema,
  SIDE_EFFECTS
} from './integrationDefinitionSchema.js';

/**
 * `contents/config/integrations.json`: the admin's installed integrations
 * (04-architecture §1.3). One definition can be installed several times, each
 * instance pointing at another endpoint, with its own label, values, groups and
 * action policy. Sensitive values never land here; `auth.credentialRef` points
 * at the credential store.
 */

const instanceIdSchema = zSafeId.min(1).max(64);

const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

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

const healthSchema = z.object({
  status: z.enum(['ok', 'error', 'unknown']).prefault('unknown'),
  checkedAt: z.string().optional(),
  actionCount: z.number().int().optional(),
  message: z.string().nullable().optional()
});

export const installedIntegrationSchema = z.object({
  id: instanceIdSchema,
  definition: integrationIdSchema,
  definitionVersion: z.string().optional(),
  label: localizedStringSchema.optional(),
  description: localizedStringSchema.optional(),
  enabled: z.boolean().prefault(true),
  /** Non-sensitive install field values. */
  values: z.record(z.string(), primitiveSchema).prefault({}),
  auth: installedAuthSchema.prefault({ mode: 'none' }),
  actions: installedActionsSchema.prefault({ enabled: ['*'], disabled: [], overrides: {} }),
  /** Groups allowed to use the instance; empty means everyone who may use the app. */
  allowedGroups: z.array(z.string().min(1)).prefault([]),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  /** Written by health checks, never by admins. */
  health: healthSchema.optional(),
  installedAt: z.string().optional(),
  updatedAt: z.string().optional()
});

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
