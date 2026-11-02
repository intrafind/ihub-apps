// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import semver from 'semver';
import {
  isStrictSemver,
  validateDefinitionMigrations
} from '../../../validators/integrationDefinitionSchema.js';
import {
  appBindsInstallation,
  bindingKeysOf,
  installationMigrationState,
  planMigration
} from './migrationPlanner.js';

/**
 * What a marketplace update would do to the installations of a definition,
 * planned from the catalog item before anything is downloaded (the update
 * dialog, versioning concept §4). The catalog item carries copies of the
 * definition's `releases` and the `migrations` they name (the last 20
 * releases), so the steps can be planned against every installation; the
 * install fields and actions are not in the catalog, so the final validation
 * runs at update time against the downloaded definition.
 *
 * The catalog lists a window of releases. An installation older than the
 * oldest listed release may need migrations of releases the catalog no
 * longer lists, so it is not planned (`planFromCatalog: false`); the real
 * plan runs against the downloaded definition when the update is applied.
 *
 * Pure: the caller hands in the installations, the apps and the definition
 * the installations are on.
 *
 * @module services/integrations/definitions/migrationPreview
 */

/** The oldest version a catalog item's release list names, or null. */
function oldestListedRelease(releases) {
  const versions = (releases || []).map(r => r?.version).filter(isStrictSemver);
  if (versions.length === 0) return null;
  return versions.sort(semver.compare)[0];
}

/**
 * The preview row of one installation: not planned (no valid version, or
 * older than the catalog's window), already current, or planned from the
 * catalog item's migrations.
 *
 * @param {object} input
 * @param {object} input.instance - a stored installation of the definition
 * @param {{ definition: object, status?: string }|null} input.entry - the loaded definition entry
 * @param {{ id: string, version: string, type?: string, migrations: Array }} input.definition
 *   - the definition as the catalog item describes it
 * @param {Array<{ path: string, data: object }>} input.apps - every app document
 * @param {string|null} input.oldest - the oldest release the catalog lists
 * @returns {{ row: object, windowed: boolean }} `windowed` when the
 *   installation is older than the catalog's window
 */
function previewInstallation({ instance, entry, definition, apps, oldest }) {
  const state = installationMigrationState(instance, entry);
  const to = definition.version;
  const from = isStrictSemver(instance.definitionVersion) ? instance.definitionVersion : null;
  const row = {
    id: instance.id,
    from,
    to,
    planFromCatalog: true,
    reason: null,
    migrations: [],
    summary: null,
    warnings: [],
    collisions: [],
    ok: true
  };
  if (!from) {
    return {
      row: {
        ...row,
        planFromCatalog: false,
        ok: false,
        reason: 'needs a review (no valid definitionVersion); the update does not migrate it'
      },
      windowed: false
    };
  }
  if (!semver.gt(to, from)) {
    return { row: { ...row, reason: `already at ${from}` }, windowed: false };
  }
  if (!oldest || semver.lt(from, oldest)) {
    return {
      row: {
        ...row,
        planFromCatalog: false,
        reason: oldest
          ? `${from} is older than the oldest release the catalog lists (${oldest}); the migration is planned against the downloaded definition when the update runs`
          : 'the catalog lists no releases; the migration is planned against the downloaded definition when the update runs'
      },
      windowed: true
    };
  }
  const keys = bindingKeysOf(instance, definition);
  const bound = apps.filter(app => appBindsInstallation(app.data, keys));
  const plan = planMigration({
    instance,
    apps: bound.map(app => ({ path: app.path, app: app.data })),
    definition,
    from,
    to,
    migrations: definition.migrations
  });
  return {
    row: {
      ...row,
      status: state.status,
      migrations: plan.migrations,
      summary: plan.summary,
      warnings: plan.warnings,
      collisions: plan.collisions,
      ok: plan.ok
    },
    windowed: false
  };
}

/**
 * @param {object} input
 * @param {string} input.definitionId
 * @param {{ version?: string, releases?: Array, migrations?: Array }} input.item - the catalog item
 * @param {Array<object>} input.instances - the stored installations of the definition
 * @param {Array<{ path: string, data: object }>} [input.apps] - every app document
 * @param {{ definition: object, status?: string }|null} [input.entry] - the loaded definition entry
 * @returns {{
 *   definitionId: string, to: string|null, planFromCatalog: boolean, reason: string|null,
 *   errors: Array<object>, installations: Array<object>
 * }}
 */
export function previewDefinitionUpdate({
  definitionId,
  item,
  instances,
  apps = [],
  entry = null
}) {
  const to = isStrictSemver(item?.version) ? item.version : null;
  const result = {
    definitionId,
    to,
    planFromCatalog: true,
    reason: null,
    errors: [],
    installations: []
  };
  if (!to) {
    return { ...result, planFromCatalog: false, reason: 'the catalog item has no version' };
  }
  const validation = validateDefinitionMigrations(item.migrations ?? [], item.releases ?? []);
  if (!validation.success) {
    return {
      ...result,
      planFromCatalog: false,
      reason: 'the catalog item lists migrations this server cannot read',
      errors: validation.errors
    };
  }
  const definition = {
    id: definitionId,
    version: to,
    type: entry?.definition?.type,
    migrations: validation.data
  };
  const oldest = oldestListedRelease(item.releases);
  let windowed = false;
  for (const instance of instances) {
    const preview = previewInstallation({ instance, entry, definition, apps, oldest });
    result.installations.push(preview.row);
    windowed ||= preview.windowed;
  }
  if (windowed) {
    result.planFromCatalog = false;
    result.reason =
      'an installation is older than the releases the catalog lists; it is planned against the downloaded definition when the update runs';
  }
  return result;
}
