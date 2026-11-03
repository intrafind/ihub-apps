// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../../configCache.js';
import registryService from '../../marketplace/RegistryService.js';
import logger from '../../../utils/logger.js';
import { definitionIdToDirName } from '../../../validators/integrationDefinitionSchema.js';
import { checkCompatibility, isNewerVersion } from './compatibility.js';
import { offeredVersion, versionPolicyFor } from '../../marketplace/versionPolicy.js';

/**
 * Newer versions of installed definitions in the marketplace catalogs.
 *
 * A definition installed from a registry is tracked in
 * `config/installations.json` under `integration:<folder name>`; the cached
 * catalog of that registry says which versions it lists, and the registry's
 * channel and the item's pin (`versionPolicy.js`) which of them this server
 * is offered: the newest that passes both. The update is
 * reported only when that version is newer than the installed one and runs
 * on this server (an incompatible newer version is reported as such, so the
 * UI can say why there is nothing to install). Built-in definitions are
 * never updated through the marketplace, so they get no entry.
 */

const COMPONENT = 'DefinitionUpdates';

/**
 * @param {Array<{ id: string, source: string, definition: { version: string } }>} entries
 *   the registry's entries (`IntegrationRegistry.list()`)
 * @returns {Promise<Map<string, {
 *   installedVersion: string,
 *   latestVersion: string,
 *   registryId: string,
 *   compatible: boolean,
 *   requires: string|null,
 *   releases: Array<object>,
 *   channel: string,
 *   pin: string|null
 * }>>} definition id → the newer catalog version
 */
export async function findDefinitionUpdates(entries) {
  const updates = new Map();
  const installations = configCache.getInstallations?.()?.data?.installations || {};
  const registries = configCache.getRegistries?.()?.data?.registries || [];
  const catalogs = new Map();
  for (const entry of entries) {
    if (entry.source !== 'installed') continue;
    const manifest = installations[`integration:${definitionIdToDirName(entry.id)}`];
    if (!manifest?.registryId) continue;
    let cached = catalogs.get(manifest.registryId);
    if (cached === undefined) {
      try {
        cached = (await registryService.getCachedCatalogAsync(manifest.registryId)) || null;
      } catch (error) {
        logger.warn('Could not read a cached marketplace catalog for update checks', {
          component: COMPONENT,
          registryId: manifest.registryId,
          error: error.message
        });
        cached = null;
      }
      catalogs.set(manifest.registryId, cached);
    }
    const item = (cached?.catalog?.items || []).find(
      i => i.type === 'integration' && i.name === manifest.itemId
    );
    if (!item?.version) continue;
    const registry = registries.find(r => r.id === manifest.registryId) || null;
    const offered = offeredVersion(item, registry);
    const installedVersion = entry.definition.version;
    if (!offered || !isNewerVersion(offered, installedVersion)) continue;
    // The catalog describes its current version; an older offered version
    // (a pin) is checked against what the catalog says of the current one.
    const { compatible, requires } = checkCompatibility(item);
    const { channel, pin } = versionPolicyFor(registry, item.type, item.name);
    updates.set(entry.id, {
      installedVersion,
      latestVersion: offered,
      registryId: manifest.registryId,
      compatible,
      requires,
      releases: Array.isArray(item.releases) ? item.releases : [],
      channel,
      pin
    });
  }
  return updates;
}
