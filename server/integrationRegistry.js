// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration Registry
 *
 * Platform integrations (configured under Admin → Integrations) that an app can
 * depend on through `requiredIntegrations`. An integration counts as on when it
 * is switched on in `platform.json`; without it the apps that need it are not
 * offered to users.
 *
 * @module integrationRegistry
 */

const integrations = {
  ifinder: platform => platform?.iFinder?.enabled === true
};

export const INTEGRATION_IDS = Object.keys(integrations);

/**
 * Whether an integration is switched on in the platform config.
 *
 * @param {string} integrationId - One of INTEGRATION_IDS
 * @param {Object} [platform] - Parsed platform.json
 * @returns {boolean} False for an unknown id
 */
export function isIntegrationEnabled(integrationId, platform = {}) {
  return Object.hasOwn(integrations, integrationId) && integrations[integrationId](platform);
}

/**
 * Whether every integration an app lists in `requiredIntegrations` is on.
 *
 * @param {Object} app - App config
 * @param {Object} [platform] - Parsed platform.json
 * @returns {boolean}
 */
export function areAppIntegrationsEnabled(app, platform = {}) {
  const required = Array.isArray(app?.requiredIntegrations) ? app.requiredIntegrations : [];
  return required.every(id => isIntegrationEnabled(id, platform));
}
