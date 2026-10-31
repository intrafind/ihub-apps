// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Local content lookup for the marketplace
 *
 * A catalog item can name an app, model, prompt, workflow or skill that
 * already exists on this instance without the marketplace having installed
 * it — every shipped default is such an item, and so is anything an admin
 * created by hand. Installing over it would replace the admin's copy, so the
 * browse views report it as `local` rather than `available`, and the
 * installer refuses to overwrite it unless the admin confirms.
 *
 * Presence is read from the ConfigCache, by id, because a hand-made file does
 * not have to be named after the id it carries.
 *
 * @module services/marketplace/localContent
 */

import integrationRegistry from '../integrations/definitions/IntegrationRegistry.js';
import { definitionIdToDirName } from '../../validators/integrationDefinitionSchema.js';

/** Loaded items per marketplace type, including disabled ones. */
const LOADED_ITEMS = {
  app: cc => cc.getApps(true).data,
  model: cc => cc.getModels(true).data,
  prompt: cc => cc.getPrompts(true).data,
  workflow: cc => cc.getWorkflows(true).data,
  skill: cc => cc.getSkills().data,
  // Definitions are not in the ConfigCache; the registry lists shipped and
  // installed ones, keyed like marketplace items by their folder name.
  integration: () =>
    integrationRegistry.list().map(entry => ({ name: definitionIdToDirName(entry.id) }))
};

/**
 * The ids of every item present on this instance, per marketplace type.
 * Skills are keyed by `name` (their directory), everything else by `id`.
 *
 * @param {object} cc - The ConfigCache
 * @returns {Record<string, Set<string>>} e.g. `{ app: Set{'chat'}, model: Set{…}, … }`
 */
export function getLocalContentIds(cc) {
  const ids = {};
  for (const [type, load] of Object.entries(LOADED_ITEMS)) {
    const items = load(cc);
    const key = type === 'skill' || type === 'integration' ? 'name' : 'id';
    ids[type] = new Set((Array.isArray(items) ? items : []).map(item => item?.[key]));
  }
  return ids;
}

/**
 * Installation status of one catalog item. An installed item whose catalog
 * version differs from the recorded one is `update-available`, which the
 * marketplace UI shows as installed with an **Update** button.
 *
 * @param {object|undefined} installation - Its entry in installations.json
 * @param {boolean} existsLocally - Whether an item with its type and name is loaded
 * @param {string} [catalogVersion] - The version the catalog offers now
 * @returns {'installed'|'update-available'|'local'|'available'}
 */
export function installationStatusFor(installation, existsLocally, catalogVersion) {
  if (installation) {
    const installedVersion = installation.version;
    if (catalogVersion && installedVersion && catalogVersion !== installedVersion) {
      return 'update-available';
    }
    return 'installed';
  }
  return existsLocally ? 'local' : 'available';
}
