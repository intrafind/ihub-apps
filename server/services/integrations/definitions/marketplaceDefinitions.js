// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../../configCache.js';
import registryService from '../../marketplace/RegistryService.js';
import { checkCompatibility, describeIncompatibility } from './compatibility.js';
import { isFeatureEnabled } from '../../../featureRegistry.js';
import { getProtocolAdapter } from '../protocols/index.js';
import { localized } from './installedValues.js';
import {
  dirNameToDefinitionId,
  INTEGRATION_ID_PATTERN
} from '../../../validators/integrationDefinitionSchema.js';
import logger from '../../../utils/logger.js';

/**
 * The integrations the marketplace offers that are not on this server yet,
 * as entries of Admin → Integrations → Catalog.
 *
 * The Catalog tab lists the loaded definitions (shipped with iHub, or
 * installed from a registry) and, next to them, every integration item of the
 * enabled registries' cached catalogs whose definition is not loaded. Install
 * on such an entry first installs the definition from its registry (the
 * marketplace's own install, with its checks), then opens the setup dialog.
 *
 * The entries are built from the cached catalog only (name, description,
 * version, compatibility, and the `facts` the registry service screened from
 * the definition when it refreshed the catalog): listing the tab never
 * fetches anything. A registry that was never refreshed contributes nothing;
 * `registries` says so, so the UI can refresh it.
 *
 * Nothing is listed when the Marketplace feature is off.
 */

const COMPONENT = 'MarketplaceDefinitions';

/**
 * @param {Array<{ id: string }>} entries - the loaded definitions (`IntegrationRegistry.list()`)
 * @param {string} [language]
 * @returns {Promise<{
 *   enabled: boolean,
 *   registries: Array<{ id: string, name: string, fetchedAt: string|null }>,
 *   items: Array<object>
 * }>}
 */
export async function findMarketplaceDefinitions(entries, language = 'en') {
  if (!isFeatureEnabled('marketplace', configCache.getFeatures?.() || {})) {
    return { enabled: false, registries: [], items: [] };
  }
  const loaded = new Set(entries.map(entry => entry.id));
  const installations = configCache.getInstallations?.()?.data?.installations || {};
  const registries = (configCache.getRegistries?.()?.data?.registries || []).filter(
    registry => registry.enabled
  );
  const seen = new Set();
  const items = [];
  const registryStates = [];
  for (const registry of registries) {
    let cached = null;
    try {
      cached = await registryService.getCachedCatalogAsync(registry.id);
    } catch (error) {
      logger.warn('Could not read a cached marketplace catalog for the integration catalog', {
        component: COMPONENT,
        registryId: registry.id,
        error: error.message
      });
    }
    registryStates.push({
      id: registry.id,
      name: registry.name || registry.id,
      fetchedAt: cached?.fetchedAt || null
    });
    for (const item of cached?.catalog?.items || []) {
      if (item?.type !== 'integration' || typeof item.name !== 'string') continue;
      const definitionId = dirNameToDefinitionId(item.name);
      if (!definitionId || !INTEGRATION_ID_PATTERN.test(definitionId)) continue;
      // Loaded already (shipped, or installed from this or another registry),
      // or offered by a registry listed earlier.
      if (loaded.has(definitionId) || seen.has(definitionId)) continue;
      if (installations[`integration:${item.name}`]) continue;
      seen.add(definitionId);
      items.push(marketplaceEntryView(item, definitionId, registry, language));
    }
  }
  return { enabled: true, registries: registryStates, items };
}

/**
 * A catalog item as a Catalog-tab entry: the fields of a loaded definition's
 * entry the tile reads, from the catalog and its screened `facts`.
 *
 * @param {object} item - the cached catalog item
 * @param {string} definitionId
 * @param {object} registry - the registry config
 * @param {string} language
 */
export function marketplaceEntryView(item, definitionId, registry, language) {
  const facts = item.facts && typeof item.facts === 'object' ? item.facts : {};
  const protocol = typeof facts.protocol === 'string' ? facts.protocol : null;
  const adapter = protocol ? getProtocolAdapter(protocol) : null;
  const { compatible, requires, serverVersion } = checkCompatibility(item);
  const incompatibleReason = compatible ? null : describeIncompatibility(requires, serverVersion);
  return {
    id: definitionId,
    version: item.version || null,
    compatibility: item.compatibility || null,
    status: compatible ? 'ok' : 'incompatible',
    statusReason: incompatibleReason,
    compatible,
    requires,
    releaseCount: Array.isArray(item.releases) ? item.releases.length : 0,
    update: null,
    name: localized(item.displayName, language, item.name),
    description: localized(item.description, language),
    publisher: item.author ? { name: item.author } : null,
    categories: item.category ? [item.category] : [],
    type: null,
    builtIn: false,
    icon: item.icon || null,
    runs: facts.runs || null,
    protocol,
    supported: Boolean(adapter),
    dynamicActions: Boolean(adapter?.dynamicActions),
    runsCode: protocol === 'script',
    alwaysInstalled: false,
    authModes: Array.isArray(facts.authModes) ? facts.authModes : [],
    actionCount: typeof facts.actionCount === 'number' ? facts.actionCount : null,
    exampleAppCount: 0,
    /** Not on this server yet: Install fetches it from `marketplace.registryId` first. */
    source: 'marketplace',
    marketplace: {
      registryId: registry.id,
      registryName: registry.name || registry.id,
      name: item.name
    },
    installedInstances: []
  };
}
