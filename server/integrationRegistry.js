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
 * - keyed by a type (`type:people-directory`): every installation of every
 *   definition of that type (`services/integrations/integrationTypes.js`),
 *   the ones installed later included; satisfied while one is enabled.
 * - `app.websearch.required: true` (with `websearch.enabled`): the app needs
 *   a web search engine — for `provider: "auto"` one enabled installation of
 *   type `web-search` (missing key `type:web-search`), for a named engine
 *   that installation (missing key: its id). Without `required`, web search
 *   never hides an app: native search needs no engine.
 *
 * An integration counts as on when it is set up and switched on; without it
 * the apps that require it are not offered to users, like an app whose
 * required feature is off. An optional binding (`required: false`) keeps the
 * app available: its actions, scopes and sources are simply not there while
 * the installation is off (`integrationTools.filterIntegrationToolsForApp`,
 * `toolLoader.resolveWebSearchEngine`).
 *
 * Each check reads a context of the config files it depends on, so it stays a
 * pure function: `{ platform, installedIntegrations, definitionTypes }` as
 * returned by `configCache.getIntegrationContext()` (`definitionTypes` maps a
 * definition id to its type). `requiredIntegrations`, the former
 * list of built-in checks, knows no id any more (the last one, people
 * directories, became installations in V198); the app schema rejects a
 * non-empty list.
 *
 * @module integrationRegistry
 */

import { typeOfBindingKey, bindingKeyOfType } from './services/integrations/integrationTypes.js';
import { WEB_SEARCH_TYPE, isWebSearchDefinition } from './services/search/webSearchEngines.js';

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
 * The type of an installation's definition, from the context's
 * `definitionTypes`, or null.
 *
 * @param {Object} instance
 * @param {Object} [context] - `{ definitionTypes }`
 * @returns {string|null}
 */
function typeOfInstance(instance, context = {}) {
  const types = context.definitionTypes;
  if (!instance?.definition || !types || typeof types !== 'object') return null;
  return Object.hasOwn(types, instance.definition) ? types[instance.definition] || null : null;
}

/**
 * Whether a type has at least one enabled installation.
 *
 * @param {string} type - e.g. `people-directory`
 * @param {Object} [context] - `{ installedIntegrations, definitionTypes }`
 * @returns {boolean}
 */
export function isTypeInstalled(type, context = {}) {
  const installed = Array.isArray(context.installedIntegrations)
    ? context.installedIntegrations
    : [];
  return installed.some(
    entry => entry?.enabled !== false && typeOfInstance(entry, context) === type
  );
}

/**
 * Whether the integration a binding key names is on: the installation, for
 * a definition key one of its installations, for a type key
 * (`type:people-directory`) one installation of that type.
 *
 * @param {string} key
 * @param {Object} [context] - `{ installedIntegrations, definitionTypes }`
 * @returns {boolean}
 */
export function isBindingSatisfied(key, context = {}) {
  const type = typeOfBindingKey(key);
  if (type) return isTypeInstalled(type, context);
  if (isInstalledIntegrationEnabled(key, context)) return true;
  return isDefinitionBinding(key, context) && isDefinitionInstalled(key, context);
}

/**
 * Every integration id with whether it is on: every installed integration by
 * its instance id, every installed definition by its id and every installed
 * type by its key `type:<type>` (on while one of their installations is).
 *
 * @param {Object} [context] - `{ installedIntegrations, definitionTypes }`
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
    const type = typeOfInstance(instance, context);
    if (!type) continue;
    const key = bindingKeyOfType(type);
    status[key] = status[key] || instance?.enabled !== false;
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
 * The key of the web search engine an app requires, or null when it requires
 * none: `type:web-search` for `provider: "auto"` (any engine will do), the
 * engine's installation id for a named one. Only an app with web search on and
 * `websearch.required: true` requires an engine; native search needs none.
 *
 * @param {Object} app - App config
 * @returns {string|null}
 */
export function requiredWebSearchKey(app) {
  const websearch = app?.websearch;
  if (!websearch?.enabled || websearch.required !== true) return null;
  const provider = websearch.provider;
  return provider && provider !== 'auto' ? provider : bindingKeyOfType(WEB_SEARCH_TYPE);
}

/**
 * Whether the web search engine an app requires is on: for `type:web-search`
 * one enabled engine installation, for an engine id that installation, enabled
 * and of type `web-search`.
 *
 * @param {string} key - from {@link requiredWebSearchKey}
 * @param {Object} [context] - `{ installedIntegrations, definitionTypes }`
 * @returns {boolean}
 */
function isWebSearchRequirementMet(key, context = {}) {
  const installed = Array.isArray(context.installedIntegrations)
    ? context.installedIntegrations
    : [];
  const isEngine = entry =>
    typeOfInstance(entry, context) === WEB_SEARCH_TYPE || isWebSearchDefinition(entry?.definition);
  if (typeOfBindingKey(key) === WEB_SEARCH_TYPE) {
    return installed.some(entry => entry?.enabled !== false && isEngine(entry));
  }
  return installed.some(entry => entry?.id === key && entry.enabled !== false && isEngine(entry));
}

/**
 * The integrations an app depends on that are off: the keys of
 * `app.integrations` whose installation is missing or disabled (for a
 * definition key: without one enabled installation; optional bindings
 * excepted), and the web search engine of an app that requires web search
 * (`type:web-search` or the engine id, see {@link requiredWebSearchKey}).
 * Empty when the app can be offered.
 *
 * @param {Object} app - App config
 * @param {Object} [context] - `{ platform, installedIntegrations }`
 * @returns {string[]}
 */
export function missingAppIntegrations(app, context = {}) {
  // A Set keeps the first-seen order and lists each key once.
  const missing = new Set(missingBoundIntegrations(app?.integrations, context));
  // Web search is switched on in the app's own settings; native search needs
  // no engine, so by default the app stays available without one.
  // `required: true` hides the app while its engine is not available: any
  // engine for `auto`, the named one otherwise.
  const webSearchKey = requiredWebSearchKey(app);
  if (webSearchKey && !isWebSearchRequirementMet(webSearchKey, context)) {
    missing.add(webSearchKey);
  }
  return [...missing];
}

/**
 * The keys of `app.integrations` whose required binding is not satisfied,
 * plus the iFinder connection of a required iAssistant binding when that
 * connection is off. In binding order; a key may repeat (the caller dedupes).
 *
 * @param {Object|undefined} bindings - `app.integrations`
 * @param {Object} context - `{ platform, installedIntegrations }`
 * @returns {string[]}
 */
function missingBoundIntegrations(bindings, context) {
  if (!bindings || typeof bindings !== 'object') return [];
  const missing = Object.keys(bindings).filter(
    key => isRequiredBinding(bindings[key]) && !isBindingSatisfied(key, context)
  );
  // iAssistant runs on the iFinder installation its `connection` names
  // (`ifinder` by default): the app is off while that connection is off too.
  if (
    Object.hasOwn(bindings, IASSISTANT_INSTANCE_ID) &&
    isRequiredBinding(bindings[IASSISTANT_INSTANCE_ID])
  ) {
    const connection = iAssistantConnectionId(context);
    if (!isInstalledIntegrationEnabled(connection, context)) missing.push(connection);
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
