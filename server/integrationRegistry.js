// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration Registry
 *
 * Integrations (configured under Admin → Integrations) that an app can depend
 * on through `requiredIntegrations`. An integration counts as on when it is
 * set up and switched on; without it the apps that need it are not offered to
 * users.
 *
 * Each check reads a context of the config files it depends on, so it stays a
 * pure function: `{ platform, peopleDirectories }` as returned by
 * `configCache.getIntegrationContext()`.
 *
 * @module integrationRegistry
 */

const integrations = {
  // Admin → Integrations → iFinder (platform.json)
  ifinder: ({ platform }) => platform?.iFinder?.enabled === true,
  // Admin → Integrations → People directories: at least one enabled directory
  // in peopleDirectories.json
  peopleDirectories: ({ peopleDirectories }) =>
    Array.isArray(peopleDirectories?.directories) &&
    peopleDirectories.directories.some(directory => directory && directory.enabled !== false)
};

export const INTEGRATION_IDS = Object.keys(integrations);

/**
 * Whether an integration is on.
 *
 * @param {string} integrationId - One of INTEGRATION_IDS
 * @param {Object} [context] - `{ platform, peopleDirectories }`
 * @returns {boolean} False for an unknown id
 */
export function isIntegrationEnabled(integrationId, context = {}) {
  return Object.hasOwn(integrations, integrationId) && integrations[integrationId](context);
}

/**
 * Every integration id with whether it is on.
 *
 * @param {Object} [context] - `{ platform, peopleDirectories }`
 * @returns {Object<string, boolean>}
 */
export function getIntegrationStatus(context = {}) {
  return Object.fromEntries(INTEGRATION_IDS.map(id => [id, isIntegrationEnabled(id, context)]));
}

/**
 * Whether every integration an app lists in `requiredIntegrations` is on.
 *
 * @param {Object} app - App config
 * @param {Object} [context] - `{ platform, peopleDirectories }`
 * @returns {boolean}
 */
export function areAppIntegrationsEnabled(app, context = {}) {
  const required = Array.isArray(app?.requiredIntegrations) ? app.requiredIntegrations : [];
  return required.every(id => isIntegrationEnabled(id, context));
}
