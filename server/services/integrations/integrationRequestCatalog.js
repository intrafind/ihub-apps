// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a user may request (#2926): the catalog entries that are not available
 * to them yet, as the read-only "Not available yet" list of Settings →
 * Integrations shows them.
 *
 * A definition is requestable when it is loaded and compatible, is not one of
 * iHub's always-installed built-ins, is not a custom integration an admin built
 * in iHub (`custom/<id>`), is not hidden by an admin, and no enabled
 * installation of it is allowed for the user's groups. The entry carries only
 * what a user needs to decide: name, description, publisher, categories,
 * capabilities and the effects of its declared actions; never install fields,
 * endpoints or the registry it came from.
 *
 * Pure: the registry entries, installations and hidden set are passed in.
 *
 * @module services/integrations/integrationRequestCatalog
 */
import { isCustomDefinitionId } from '../../validators/integrationDefinitionSchema.js';
import { localized } from './definitions/installedValues.js';
import { mayUseIntegration } from './integrationAccess.js';
import { effectsOf } from './userIntegrations.js';

/** An http(s) icon URL of the definition, or null (companion icons are not served). */
function iconOf(definition) {
  const icon = definition?.icon;
  return typeof icon === 'string' && /^https?:\/\//i.test(icon) ? icon : null;
}

/**
 * Whether the user may use an enabled installation of the definition.
 *
 * @param {string} definitionId
 * @param {Object[]} installations
 * @param {Object} user
 * @returns {boolean}
 */
export function availableToUser(definitionId, installations, user) {
  return (installations || []).some(
    instance =>
      instance?.definition === definitionId &&
      instance.enabled !== false &&
      mayUseIntegration(instance, user)
  );
}

/**
 * Whether a registry entry can be requested by the user.
 *
 * @param {{ definition: Object, status?: string }} entry - A registry entry
 * @param {Object} context
 * @param {Object[]} context.installations
 * @param {Object} context.user
 * @param {Set<string>} context.hidden - Hidden definition ids
 * @returns {boolean}
 */
export function isRequestable(entry, { installations, user, hidden }) {
  const definition = entry?.definition;
  if (!definition?.id) return false;
  if (entry.status === 'incompatible') return false;
  if (definition.alwaysInstalled === true) return false;
  // A custom integration is one an admin built in iHub for their own use; it
  // is not in the catalog users choose from, whatever groups they are in.
  if (isCustomDefinitionId(definition.id)) return false;
  if (hidden?.has(definition.id)) return false;
  return !availableToUser(definition.id, installations, user);
}

/**
 * The user-facing view of a catalog entry.
 *
 * @param {{ definition: Object }} entry
 * @param {string} language
 * @returns {Object}
 */
export function requestCatalogEntry(entry, language) {
  const def = entry.definition;
  const actions = Array.isArray(def.actions) ? def.actions : [];
  return {
    definition: def.id,
    name: localized(def.name, language, def.id),
    description: localized(def.description, language),
    icon: iconOf(def),
    publisher: def.publisher?.name || null,
    categories: Array.isArray(def.categories) ? [...def.categories] : [],
    capabilities: Array.isArray(def.capabilities) ? [...def.capabilities] : [],
    actionCount: actions.length,
    effects: effectsOf(actions)
  };
}

/**
 * The definition's display name, or its id when the registry no longer has it.
 *
 * @param {Object|null} entry - A registry entry
 * @param {string} definitionId
 * @param {string} language
 */
export function definitionNameOf(entry, definitionId, language) {
  return entry?.definition
    ? localized(entry.definition.name, language, definitionId)
    : definitionId;
}
