// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration Registry
 *
 * Which integrations an app depends on, and whether they are on. An app
 * depends on an integration in two ways:
 *
 * - `requiredIntegrations`: the built-in checks below (people directories),
 *   configured under Admin → Integrations;
 * - `app.integrations[<id>]`: a binding to an installed integration (Admin →
 *   Integrations → Installed, `config/integrations.json`), which must exist
 *   and be enabled. The built-in iFinder and iAssistant are the installations
 *   `ifinder` and `iassistant`.
 *
 * An integration counts as on when it is set up and switched on; without it
 * the apps that need it are not offered to users, like an app whose required
 * feature is off.
 *
 * Each check reads a context of the config files it depends on, so it stays a
 * pure function: `{ platform, peopleDirectories, installedIntegrations }` as
 * returned by `configCache.getIntegrationContext()`.
 *
 * @module integrationRegistry
 */

const integrations = {
  // Admin → Integrations → People directories: at least one enabled directory
  // in peopleDirectories.json
  peopleDirectories: ({ peopleDirectories }) =>
    Array.isArray(peopleDirectories?.directories) &&
    peopleDirectories.directories.some(directory => directory && directory.enabled !== false)
};

export const INTEGRATION_IDS = Object.keys(integrations);

/** The built-in installations (`config/integrations.json`). */
const IFINDER_INSTANCE_ID = 'ifinder';
const IASSISTANT_INSTANCE_ID = 'iassistant';

/**
 * Whether an installed integration (`config/integrations.json`) exists and is
 * enabled.
 *
 * @param {string} instanceId
 * @param {Object} [context] - `{ installedIntegrations }`
 * @returns {boolean}
 */
export function isInstalledIntegrationEnabled(instanceId, context = {}) {
  const installed = Array.isArray(context.installedIntegrations)
    ? context.installedIntegrations
    : [];
  const instance = installed.find(entry => entry?.id === instanceId);
  return Boolean(instance) && instance.enabled !== false;
}

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
 * Every integration id with whether it is on: the built-in checks, then every
 * installed integration by its instance id (an installation never takes a
 * built-in id; the service reserves them).
 *
 * @param {Object} [context] - `{ platform, peopleDirectories, installedIntegrations }`
 * @returns {Object<string, boolean>}
 */
export function getIntegrationStatus(context = {}) {
  const installed = Array.isArray(context.installedIntegrations)
    ? context.installedIntegrations
    : [];
  return {
    ...Object.fromEntries(
      installed
        .filter(instance => instance?.id)
        .map(instance => [instance.id, instance.enabled !== false])
    ),
    ...Object.fromEntries(INTEGRATION_IDS.map(id => [id, isIntegrationEnabled(id, context)]))
  };
}

/**
 * The integrations an app depends on that are off: ids from
 * `requiredIntegrations`, and the keys of `app.integrations` whose installation
 * is missing or disabled. Empty when the app can be offered.
 *
 * @param {Object} app - App config
 * @param {Object} [context] - `{ platform, peopleDirectories, installedIntegrations }`
 * @returns {string[]}
 */
export function missingAppIntegrations(app, context = {}) {
  const missing = [];
  const required = Array.isArray(app?.requiredIntegrations) ? app.requiredIntegrations : [];
  for (const id of required) {
    if (!isIntegrationEnabled(id, context)) missing.push(id);
  }
  const bindings = app?.integrations;
  if (bindings && typeof bindings === 'object') {
    for (const key of Object.keys(bindings)) {
      if (!isInstalledIntegrationEnabled(key, context) && !missing.includes(key)) missing.push(key);
    }
    // iAssistant runs on the iFinder installation its `connection` names
    // (`ifinder` by default): the app is off while that connection is off too.
    if (Object.hasOwn(bindings, IASSISTANT_INSTANCE_ID)) {
      const connection = iAssistantConnectionId(context);
      if (!isInstalledIntegrationEnabled(connection, context) && !missing.includes(connection)) {
        missing.push(connection);
      }
    }
  }
  // Web search is switched on in the app's own settings; its tools belong to
  // the `websearch` installation, so that installation is a requirement too.
  if (app?.websearch?.enabled && !isInstalledIntegrationEnabled('websearch', context)) {
    if (!missing.includes('websearch')) missing.push('websearch');
  }
  return missing;
}

/**
 * The id of the iFinder installation the iAssistant installation runs on.
 * @param {Object} [context] - `{ installedIntegrations }`
 * @returns {string}
 */
function iAssistantConnectionId(context = {}) {
  const installed = Array.isArray(context.installedIntegrations)
    ? context.installedIntegrations
    : [];
  const instance = installed.find(entry => entry?.id === IASSISTANT_INSTANCE_ID);
  const connection = instance?.values?.connection;
  return typeof connection === 'string' && connection ? connection : IFINDER_INSTANCE_ID;
}

/**
 * Whether every integration an app depends on is on (see
 * `missingAppIntegrations`).
 *
 * @param {Object} app - App config
 * @param {Object} [context] - `{ platform, peopleDirectories, installedIntegrations }`
 * @returns {boolean}
 */
export function areAppIntegrationsEnabled(app, context = {}) {
  return missingAppIntegrations(app, context).length === 0;
}
