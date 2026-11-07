// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import configCache from '../../configCache.js';
import {
  DEFAULT_SEARCH_PRESET,
  MAPPED_PERSON_FIELDS,
  SEARCH_PRESETS
} from '../../services/peopleDirectory/presets.js';
import {
  LDAP_BROWSE_DEFAULTS,
  LDAP_BROWSE_LIMITS,
  PEOPLE_DIRECTORY_DEFAULTS,
  PEOPLE_DIRECTORY_LIMITS
} from '../../validators/peopleDirectorySchema.js';

/**
 * What the dedicated editors of **People directory (LDAP)** and **LDAP
 * browser** need besides the installation itself (Admin → Integrations →
 * an installation → Settings, `client/src/features/admin/components/integrations/editors/`):
 *
 * - the search presets with their person filter, searched attributes and
 *   mapping, so the editor shows the effective value of every field left
 *   empty;
 * - the person fields a mapping fills, the defaults and upper bounds of the
 *   limits (people search and LDAP browser);
 * - the LDAP sign-in providers a directory can reuse, without their secrets;
 * - for the Entra ID directory editor, which `AZURE_*` environment variables
 *   are set (names and booleans, never values).
 *
 * Read-only and behind `adminAuth`; the values are the server's own, so the
 * client never mirrors them.
 */

/**
 * The sign-in providers a directory can reuse, without their secrets: the
 * bind password reference is never sent, only whether a bind account exists.
 * @param {Object} platform
 * @returns {Object[]}
 */
export function ldapProviderSummaries(platform) {
  return (platform?.ldapAuth?.providers || [])
    .filter(provider => provider?.name)
    .map(provider => {
      let host = null;
      try {
        host = new URL(String(provider.url || '').trim()).hostname || null;
      } catch {
        host = null;
      }
      return {
        name: provider.name,
        displayName: provider.displayName || provider.name,
        url: provider.url || null,
        host,
        baseDn: provider.baseDn || null,
        userSearchBase: provider.userSearchBase || null,
        preset: provider.preset || null,
        starttls: provider.starttls === true,
        hasBindAccount: Boolean(provider.adminDn)
      };
    });
}

/** The variables the Entra ID directory falls back to when a field is empty. */
const ENTRA_ENVIRONMENT = Object.freeze({
  tenantId: 'AZURE_TENANT_ID',
  clientId: 'AZURE_CLIENT_ID',
  clientSecret: 'AZURE_CLIENT_SECRET'
});

/**
 * Which `AZURE_*` variables are set on the server: names and booleans only,
 * never a value.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Object<string, {variable: string, set: boolean}>}
 */
export function entraEnvironmentOf(env = process.env) {
  return Object.fromEntries(
    Object.entries(ENTRA_ENVIRONMENT).map(([field, variable]) => [
      field,
      { variable, set: typeof env[variable] === 'string' && env[variable].trim() !== '' }
    ])
  );
}

/**
 * The editor context as the route returns it.
 * @param {Object} platform
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Object}
 */
export function peopleDirectoryEditorContext(platform, env = process.env) {
  return {
    presets: Object.values(SEARCH_PRESETS).map(preset => ({
      id: preset.id,
      label: preset.label,
      personFilter: preset.personFilter,
      searchAttributes: preset.searchAttributes,
      attributeMapping: Object.fromEntries(
        MAPPED_PERSON_FIELDS.map(field => [field, preset.attributeMapping[field] || []])
      )
    })),
    defaultPreset: DEFAULT_SEARCH_PRESET,
    fields: MAPPED_PERSON_FIELDS,
    defaults: { ...PEOPLE_DIRECTORY_DEFAULTS },
    limits: { ...PEOPLE_DIRECTORY_LIMITS },
    browse: { defaults: { ...LDAP_BROWSE_DEFAULTS }, limits: { ...LDAP_BROWSE_LIMITS } },
    ldapProviders: ldapProviderSummaries(platform),
    entraEnvironment: entraEnvironmentOf(env)
  };
}

export default function registerAdminPeopleDirectoryEditorRoutes(app) {
  /**
   * @swagger
   * /api/admin/integrations/people-directories/editor-context:
   *   get:
   *     summary: Context of the people directory and LDAP browser editors
   *     description: |
   *       The search presets with their mappings, the person fields, the
   *       defaults and upper bounds of the limits, the LDAP sign-in
   *       providers a directory can reuse (without secrets) and which
   *       AZURE_* variables are set (booleans only).
   *     tags: [Admin]
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: The editor context
   */
  app.get(
    buildServerPath('/api/admin/integrations/people-directories/editor-context'),
    adminAuth,
    (req, res) => {
      res.json(peopleDirectoryEditorContext(configCache.getPlatform() || {}));
    }
  );
}
