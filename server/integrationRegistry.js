// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration Registry
 *
 * Which integrations an app depends on, and whether they are on. An app
 * depends on an integration through `app.integrations[<key>]`, a binding to
 * an installed integration (Admin → Integrations → Installed,
 * `config/integrations.json`), which must exist and be enabled unless the
 * binding says `required: false`:
 *
 * - keyed by an installation id (`ifinder`, `jira`, `open-data-portal`): that
 *   installation; the built-in iFinder and iAssistant are the installations
 *   `ifinder` and `iassistant`;
 * - keyed by a definition id (`com.intrafind/ldap-directory`): every
 *   installation of that definition, the ones installed later included; the
 *   binding is satisfied while at least one of them is enabled.
 * - `app.websearch.enabled`: web search runs on the `websearch` installation;
 *   it counts as a requirement only with `websearch.required: true`.
 *
 * An integration counts as on when it is set up and switched on; without it
 * the apps that require it are not offered to users, like an app whose
 * required feature is off. An optional binding (`required: false`) keeps the
 * app available: its actions, scopes and sources are simply not there while
 * the installation is off (`integrationTools.filterIntegrationToolsForApp`,
 * `toolLoader.isWebSearchAvailableTo`).
 *
 * Each check reads a context of the config files it depends on, so it stays a
 * pure function: `{ platform, installedIntegrations }` as returned by
 * `configCache.getIntegrationContext()`. `requiredIntegrations`, the former
 * list of built-in checks, knows no id any more (the last one, people
 * directories, became installations in V198); the app schema rejects a
 * non-empty list.
 *
 * @module integrationRegistry
 */

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
 * Whether a definition has at least one enabled installation.
 *
 * @param {string} definitionId
 * @param {Object} [context] - `{ installedIntegrations }`
 * @returns {boolean}
 */
export function isDefinitionInstalled(definitionId, context = {}) {
  const installed = Array.isArray(context.installedIntegrations)
    ? context.installedIntegrations
    : [];
  return installed.some(entry => entry?.definition === definitionId && entry.enabled !== false);
}

/**
 * Whether a binding key names a definition rather than an installation: no
 * installation has the id, and at least one installation (enabled or not)
 * has it as its definition.
 *
 * @param {string} key - A key of `app.integrations`
 * @param {Object} [context] - `{ installedIntegrations }`
 * @returns {boolean}
 */
export function isDefinitionBinding(key, context = {}) {
  const installed = Array.isArray(context.installedIntegrations)
    ? context.installedIntegrations
    : [];
  if (installed.some(entry => entry?.id === key)) return false;
  return installed.some(entry => entry?.definition === key);
}

/**
 * Whether the integration a binding key names is on: the installation, or
 * for a definition key one of its installations.
 *
 * @param {string} key
 * @param {Object} [context] - `{ installedIntegrations }`
 * @returns {boolean}
 */
export function isBindingSatisfied(key, context = {}) {
  if (isInstalledIntegrationEnabled(key, context)) return true;
  return isDefinitionBinding(key, context) && isDefinitionInstalled(key, context);
}

/**
 * Every integration id with whether it is on: every installed integration by
 * its instance id, and every installed definition by its id (on while one of
 * its installations is).
 *
 * @param {Object} [context] - `{ installedIntegrations }`
 * @returns {Object<string, boolean>}
 */
export function getIntegrationStatus(context = {}) {
  const installed = Array.isArray(context.installedIntegrations)
    ? context.installedIntegrations
    : [];
  const status = {};
  for (const instance of installed) {
    if (!instance?.definition) continue;
    status[instance.definition] = status[instance.definition] || instance.enabled !== false;
  }
  for (const instance of installed) {
    if (instance?.id) status[instance.id] = instance.enabled !== false;
  }
  return status;
}

/**
 * Whether a binding hides its app while the installation is off. Absent means
 * required; only an explicit `required: false` makes the binding optional.
 *
 * @param {Object} [binding] - `app.integrations[<id>]`
 * @returns {boolean}
 */
export function isRequiredBinding(binding) {
  return binding?.required !== false;
}

/**
 * The integrations an app depends on that are off: the keys of
 * `app.integrations` whose installation is missing or disabled (for a
 * definition key: without one enabled installation; optional bindings
 * excepted), and `websearch` for an app that requires web search. Empty when
 * the app can be offered.
 *
 * @param {Object} app - App config
 * @param {Object} [context] - `{ platform, installedIntegrations }`
 * @returns {string[]}
 */
export function missingAppIntegrations(app, context = {}) {
  const missing = [];
  const bindings = app?.integrations;
  if (bindings && typeof bindings === 'object') {
    for (const key of Object.keys(bindings)) {
      if (!isRequiredBinding(bindings[key])) continue;
      if (!isBindingSatisfied(key, context) && !missing.includes(key)) missing.push(key);
    }
    // iAssistant runs on the iFinder installation its `connection` names
    // (`ifinder` by default): the app is off while that connection is off too.
    if (
      Object.hasOwn(bindings, IASSISTANT_INSTANCE_ID) &&
      isRequiredBinding(bindings[IASSISTANT_INSTANCE_ID])
    ) {
      const connection = iAssistantConnectionId(context);
      if (!isInstalledIntegrationEnabled(connection, context) && !missing.includes(connection)) {
        missing.push(connection);
      }
    }
  }
  // Web search is switched on in the app's own settings; its tools belong to
  // the `websearch` installation. By default the app stays available without
  // it (the search toggle and native search drop out); `required: true` hides
  // the app like a required binding does.
  if (
    app?.websearch?.enabled &&
    app.websearch.required === true &&
    !isInstalledIntegrationEnabled('websearch', context)
  ) {
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
 * @param {Object} [context] - `{ platform, installedIntegrations }`
 * @returns {boolean}
 */
export function areAppIntegrationsEnabled(app, context = {}) {
  return missingAppIntegrations(app, context).length === 0;
}
