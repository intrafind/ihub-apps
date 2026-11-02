// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendInternalError } from '../../utils/responseHelpers.js';
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
 * - the LDAP sign-in providers a directory can reuse, without their secrets.
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

/**
 * The editor context as the route returns it.
 * @param {Object} platform
 * @returns {Object}
 */
export function peopleDirectoryEditorContext(platform) {
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
    ldapProviders: ldapProviderSummaries(platform)
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
   *       defaults and upper bounds of the limits, and the LDAP sign-in
   *       providers a directory can reuse (without secrets).
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
      try {
        res.json(peopleDirectoryEditorContext(configCache.getPlatform() || {}));
      } catch (error) {
        return sendInternalError(res, error, 'load the people directory editor context');
      }
    }
  );
}
