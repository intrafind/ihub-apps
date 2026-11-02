// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { expandUserGroups } from '../../utils/groupInheritance.js';
import { getDefaultAnonymousGroups, getPermissionsForUser } from '../../utils/authorization.js';
import { bindingKeyOfType, getDefinitionTypes } from './integrationTypes.js';

/**
 * Who may use an installed integration (#3093).
 *
 * Groups decide: `groups.json` → `permissions.integrations` lists what the
 * members of a group may use, resolved with inheritance like `apps` and
 * exposed on the enhanced user as `user.permissions.integrations` (a Set).
 * A key grants an installation when it is
 *
 * - `*` — every installation, the ones installed later included;
 * - the installation id (`ifinder`, `x500bund`);
 * - its definition id (`com.intrafind/ldap-directory`) — every installation
 *   of that definition;
 * - its definition's type key (`type:people-directory`) — every installation
 *   of every definition of that type.
 *
 * The grant holds on top of every app binding and tool grant: an app that
 * binds an installation offers its tools, scopes and sources only to users
 * whose groups grant it. Installations carry no groups of their own any more
 * (`allowedGroups` was removed; migration V202 moved it onto the groups).
 *
 * Pure checks, no I/O: they read the user, the groups configuration and the
 * definition types the registry published (`integrationTypes.getDefinitionTypes`),
 * so the tool loader, the people directory service and the routes can all
 * use them without an import cycle.
 *
 * @module services/integrations/integrationAccess
 */

const COMPONENT = 'IntegrationAccess';

/** The key that grants every installation. */
export const ALL_INTEGRATIONS = '*';

/**
 * The type of an installation's definition (`people-directory`, `web-search`,
 * `storage`), from the types the registry published, or null.
 * @param {{ definition?: string }|null} instance
 * @returns {string|null}
 */
export function typeOfInstallation(instance) {
  const definition = instance?.definition;
  if (typeof definition !== 'string' || !definition) return null;
  const types = getDefinitionTypes();
  return Object.hasOwn(types, definition) ? types[definition] || null : null;
}

/**
 * The permission keys that grant one installation, most specific first:
 * its id, its definition id and its type key. `*` grants every installation
 * and is not listed.
 *
 * @param {{ id: string, definition?: string }} instance
 * @returns {string[]} e.g. `['x500bund', 'com.intrafind/ldap-directory', 'type:people-directory']`
 */
export function integrationGrantKeys(instance) {
  if (!instance?.id) return [];
  const keys = [instance.id];
  if (typeof instance.definition === 'string' && instance.definition) {
    keys.push(instance.definition);
  }
  const type = typeOfInstallation(instance);
  if (type) keys.push(bindingKeyOfType(type));
  return keys;
}

/** The anonymous principal's groups (`anonymousAuth.defaultGroups`). */
function anonymousGroups() {
  let platform = {};
  try {
    platform = configCache.getPlatform?.() || {};
  } catch {
    platform = {};
  }
  return getDefaultAnonymousGroups(platform);
}

/**
 * The integration keys a user's groups grant, as a Set.
 *
 * Reads `user.permissions.integrations` when the user was enhanced
 * (`enhanceUserWithPermissions`, which also decides for OAuth clients and
 * delegated tokens). A user object without resolved permissions — built by
 * hand, restored from JSON (a Set serializes to `{}`), or none at all — is
 * resolved from its groups, inherited groups included; no user at all is the
 * anonymous principal. Never "everything" by default: such an object is
 * resolved from its groups whatever else it claims, and a resolution that
 * fails grants nothing.
 *
 * @param {Object|null|undefined} user - `{ groups, permissions? }`
 * @returns {Set<string>}
 *
 * @example
 * integrationPermissionsOf({ groups: ['users'] }); // Set { '*' } with the shipped groups.json
 */
export function integrationPermissionsOf(user) {
  const resolved = user?.permissions?.integrations;
  if (resolved instanceof Set) return resolved;
  if (Array.isArray(resolved)) return new Set(resolved);
  const groups = Array.isArray(user?.groups) ? user.groups : anonymousGroups();
  try {
    // Expanded here as well: the groups cache holds inheritance resolved,
    // but a raw configuration (tests, a cache not loaded yet) would not.
    const permissions = getPermissionsForUser([...expandUserGroups(groups)]);
    return permissions.integrations instanceof Set ? permissions.integrations : new Set();
  } catch (error) {
    logger.warn('Could not resolve the integration permissions of a user; granting none', {
      component: COMPONENT,
      userId: user?.id || null,
      error: error.message
    });
    return new Set();
  }
}

/**
 * Whether a set of granted keys admits an installation.
 * @param {Set<string>} granted - from {@link integrationPermissionsOf}
 * @param {{ id: string, definition?: string }} instance
 * @returns {boolean}
 */
export function grantsIntegration(granted, instance) {
  if (!instance?.id || !(granted instanceof Set) || granted.size === 0) return false;
  if (granted.has(ALL_INTEGRATIONS)) return true;
  return integrationGrantKeys(instance).some(key => granted.has(key));
}

/**
 * Whether the user's groups grant the installation: `*`, its id, its
 * definition id or its type key in `permissions.integrations`. Whether the
 * installation is enabled is not checked here.
 *
 * @param {{ id: string, definition?: string }|null} instance
 * @param {Object|null|undefined} user
 * @returns {boolean}
 */
export function mayUseIntegration(instance, user) {
  if (!instance?.id) return false;
  return grantsIntegration(integrationPermissionsOf(user), instance);
}
