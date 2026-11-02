// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../../utils/logger.js';
import { RESERVED_TOOL_CONTEXT_KEYS } from '../../utils/toolCallContext.js';
import { isToolSelected } from '../../utils/toolSelection.js';
import installedIntegrationService from './InstalledIntegrationService.js';
import { bindingKeyOfType, getDefinitionTypes } from './integrationTypes.js';
import {
  grantsIntegration,
  integrationPermissionsOf,
  mayUseIntegration
} from './integrationAccess.js';
import { getProtocolAdapter } from './protocols/index.js';
import { localized } from './definitions/installedValues.js';
import { fingerprintOfTool, fingerprintsOfActions, observeInBackground } from './actionReview.js';
import { integrationInstructionsOf, withActionOverrides } from './actionGuidance.js';
import { recordActionEvent } from './actionUsage.js';
import {
  registerScopeProvider,
  unregisterScopeProvider,
  appScopeSettings,
  pickDefaultScope
} from './scopes/index.js';

/**
 * Installed integrations as tools.
 *
 * Every available action of every enabled installation is a tool
 * `<instanceId>__<action>` carrying `_integration: { instanceId, action }`.
 * An app binds an installation by listing it under `app.integrations` (the
 * same object that holds the per-integration scope settings of #3050):
 *
 * ```json
 * "integrations": {
 *   "ckan-demo": { "actions": ["search_datasets", "get_dataset"], "defaultScope": "stadt-norderstedt" }
 * }
 * ```
 *
 * Without `actions`, every available action is bound. The user's scope pick
 * (`params.integrationScopes[instanceId]`) reaches the adapter and is applied
 * after the model's arguments.
 *
 * A key may also be a definition id (`"com.intrafind/ldap-directory": {}`):
 * that binds every installation of the definition, the ones installed later
 * included, with the same `actions` and `required` settings. A binding of
 * one installation wins over the binding of its definition.
 */

const COMPONENT = 'IntegrationTools';
/** Scope id meaning "no scope filter" when a definition lists nothing to pick. */
export const ALL_SCOPE_ID = '__all__';

const CONTEXT_KEYS = new Set([
  ...RESERVED_TOOL_CONTEXT_KEYS,
  'language',
  'clientTimezone',
  '_chatStored'
]);

/** Whether a tool belongs to an installed integration. */
export function isIntegrationTool(tool) {
  return Boolean(tool && tool._integration);
}

/**
 * A tool from an action of an installation. The description is the admin's
 * override or the definition's; the action's guidance travels on the marker
 * (`_integration.guidance`) and reaches the system prompt through
 * `actionGuidance.appendIntegrationGuidance`, not the tool description (#2974).
 */
export function toolFromAction(resolved, rawAction, language, fingerprint = null) {
  const { instance, definition, label } = resolved;
  const action = withActionOverrides(rawAction, instance, language);
  const title = action.title || action.name;
  return {
    id: action.toolId,
    name: `${label}: ${title}`,
    description: action.description || title,
    parameters: action.parameters,
    type: 'integration',
    _integration: {
      instanceId: instance.id,
      instanceLabel: label,
      action: action.name,
      // The action's own title ("Search people"), which the chat shows beside the label.
      actionTitle: title,
      definition: definition.id,
      // A built-in that kept the tool id it had before (`iFinder_search`).
      fixedToolId: action.toolId !== `${instance.id}__${action.name}`,
      // Bound only when a binding names the action (`bindExplicitly` in the definition).
      ...(action.bindExplicitly ? { bindExplicitly: true } : {}),
      // Model guidance for the system prompt while the integration is active (#2974).
      ...(action.guidance ? { guidance: action.guidance } : {}),
      // Name, declared side effect and input schema (#2916): compared by the
      // approval resolver with the fingerprint an admin accepted.
      ...(fingerprint ? { fingerprint } : {})
    },
    sideEffect: action.sideEffect,
    dataFlow: action.dataFlow,
    readOnly: action.sideEffect === 'read',
    examples: action.examples,
    sources: action.sources,
    instructions: integrationInstructionsOf(definition, instance, language).text || undefined,
    // A connector may add fields of its own (a people directory's or an LDAP browser's marker).
    ...(action.extras && typeof action.extras === 'object' ? action.extras : {})
  };
}

/**
 * The key under `app.integrations` that binds an installation: its own id,
 * else its definition id, else its definition's type key (`type:<type>`).
 * Null when the app binds none of them.
 * @param {object} app
 * @param {{ id: string, definition?: string }|null|undefined} instance
 * @returns {string|null}
 */
export function bindingKeyFor(app, instance) {
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object' || !instance?.id) return null;
  if (Object.hasOwn(bindings, instance.id)) return instance.id;
  if (instance.definition && Object.hasOwn(bindings, instance.definition)) {
    return instance.definition;
  }
  const types = getDefinitionTypes();
  const type =
    instance.definition && Object.hasOwn(types, instance.definition)
      ? types[instance.definition]
      : null;
  if (type && Object.hasOwn(bindings, bindingKeyOfType(type))) return bindingKeyOfType(type);
  return null;
}

/**
 * The binding an app has for an installation: its own, else the one of its
 * definition, else the one of its definition's type (`type:<type>`). Null
 * when the app binds none of them.
 * @param {object} app
 * @param {{ id: string, definition?: string }} instance
 * @returns {object|null}
 */
export function appBindingFor(app, instance) {
  const key = bindingKeyFor(app, instance);
  return key === null ? null : app.integrations[key] || {};
}

/**
 * Whether a chat's `enabledTools` keeps a tool the app binds under
 * `app.integrations`. The chat names a bound integration by the key the app
 * binds it with, so a definition id (`com.intrafind/office365`) or a type key
 * (`type:storage`) keeps the tools of every installation it binds, exactly as
 * an installation id keeps its own.
 * @param {object} app
 * @param {object} tool - a tool `getIntegrationToolsForApp` returned
 * @param {string[]} enabledTools
 * @returns {boolean}
 */
export function isBoundToolEnabled(app, tool, enabledTools) {
  if (isToolSelected(tool, enabledTools)) return true;
  const instance = installedIntegrationService.get(tool?._integration?.instanceId);
  const key = bindingKeyFor(app, instance);
  return key !== null && enabledTools.includes(key);
}

/**
 * A ready-made tool of an MCP or A2A installation with the admin's text
 * overrides (#2974): description, guidance on the marker, the installation's
 * instructions; plus its fingerprint (#2916). The fingerprint is taken before
 * and never covers the description.
 * @param {Object} tool - an adapter's `discoverTools` result
 * @param {Object} instance
 * @param {string} language
 * @param {string|null} fingerprint
 * @param {string} instructions - the installation's model guidance
 * @returns {Object}
 */
function withToolOverrides(tool, instance, language, fingerprint, instructions) {
  const actionName = tool._integration?.action;
  const shaped = actionName
    ? withActionOverrides(
        { name: actionName, description: tool.description || '', guidance: '', examples: [] },
        instance,
        language
      )
    : null;
  return {
    ...tool,
    ...(shaped?.overridden.description ? { description: shaped.description } : {}),
    ...(instructions ? { instructions } : {}),
    ...(shaped?.examples.length ? { examples: shaped.examples } : {}),
    _integration: {
      ...tool._integration,
      ...(fingerprint ? { fingerprint } : {}),
      ...(shaped?.guidance ? { guidance: shaped.guidance } : {})
    }
  };
}

/**
 * Tools of every enabled installation (for `loadTools`).
 * @param {string|null} language
 */
export async function discoverIntegrationTools(language = null) {
  const lang = language || 'en';
  let resolvedAll;
  try {
    resolvedAll = await installedIntegrationService.resolveAllEnabled(lang);
  } catch (error) {
    logger.error('Could not resolve installed integrations', { component: COMPONENT, error });
    return [];
  }
  const tools = [];
  for (const resolved of resolvedAll) {
    const adapter = getProtocolAdapter(resolved.definition.protocol.type);
    try {
      // An adapter over a system that already shapes tools (MCP) hands them
      // over as they are, with the integration marker added.
      if (typeof adapter.discoverTools === 'function') {
        const fingerprints = {};
        const instructions = integrationInstructionsOf(
          resolved.definition,
          resolved.instance,
          lang,
          adapter.serverInstructions?.(resolved.instance) || null
        ).text;
        for (const tool of await adapter.discoverTools(resolved, lang)) {
          const fingerprint = fingerprintOfTool(tool);
          if (fingerprint && tool._integration?.action) {
            fingerprints[tool._integration.action] = fingerprint;
          }
          tools.push(withToolOverrides(tool, resolved.instance, lang, fingerprint, instructions));
        }
        // Only the actions switched on are listed here: compared, never a baseline.
        observeInBackground(resolved.instance.id, fingerprints, { complete: false });
        continue;
      }
      // Every action, the unavailable ones included, so the fingerprints are
      // complete; only the available ones become tools.
      const actions = await adapter.discoverActions({
        definition: resolved.definition,
        instance: resolved.instance,
        document: resolved.document,
        security: resolved.security,
        language: lang,
        includeUnavailable: true
      });
      const fingerprints = fingerprintsOfActions(actions, resolved.definition);
      observeInBackground(resolved.instance.id, fingerprints, { complete: true });
      for (const action of actions) {
        if (!action.available) continue;
        tools.push(toolFromAction(resolved, action, lang, fingerprints[action.name] || null));
      }
    } catch (error) {
      logger.error('Could not discover the actions of an installed integration', {
        component: COMPONENT,
        instanceId: resolved.instance.id,
        error: error.message
      });
    }
  }
  return tools;
}

/**
 * Whether the user's groups grant the installation (`permissions.integrations`:
 * `*`, its id, its definition id or its type key; see `integrationAccess.js`).
 * Holds on top of every tool grant and app binding.
 * @param {object} instance
 * @param {object} user
 */
export function userMayUse(instance, user) {
  return mayUseIntegration(instance, user);
}

/**
 * Drop the integration tools of installations the user's groups do not grant
 * (or whose installation is gone or disabled). The grant holds on top of
 * every tool grant: `runIntegrationTool` refuses such a call, so the listing
 * must not offer it either. The user's grants are resolved once per call.
 * @param {Array} tools
 * @param {object} user
 */
export function filterIntegrationToolsForUser(tools, user) {
  let granted = null;
  return tools.filter(tool => {
    if (!isIntegrationTool(tool)) return true;
    const instance = installedIntegrationService.get(tool._integration.instanceId);
    if (!instance || instance.enabled === false) return false;
    granted ??= integrationPermissionsOf(user);
    return grantsIntegration(granted, instance);
  });
}

/**
 * The installation ids an app binds: the keys of `app.integrations` that are
 * installed, plus every installation of a definition it binds.
 */
export function boundInstanceIds(app) {
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object') return [];
  const ids = new Set();
  for (const instance of installedIntegrationService.list()) {
    if (appBindingFor(app, instance)) ids.add(instance.id);
  }
  return [...ids];
}

/**
 * The integration tools an app offers, from the already loaded tool list.
 * @param {object} app
 * @param {Array} allTools - result of `loadTools()`
 * @param {object} context - `{ user }`
 */
export function getIntegrationToolsForApp(app, allTools, context = {}) {
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object') return [];
  const out = [];
  let granted = null;
  for (const tool of allTools) {
    if (!isIntegrationTool(tool)) continue;
    const { instanceId, action } = tool._integration;
    const instance = installedIntegrationService.get(instanceId);
    if (!instance || instance.enabled === false) continue;
    const binding = appBindingFor(app, instance);
    if (!binding) continue;
    granted ??= integrationPermissionsOf(context.user);
    if (!grantsIntegration(granted, instance)) continue;
    if (bindingOffersAction(binding, action, tool._integration)) out.push(tool);
  }
  return out;
}

/**
 * Whether an app's binding of an installation offers one of its actions.
 * `actions` absent: every action except those bound explicitly only; a list
 * (even empty): exactly those. An empty list binds the installation for its
 * scopes and nothing else.
 *
 * @param {{ actions?: string[] }} binding - the app's binding (`appBindingFor`)
 * @param {string} action - the action's name
 * @param {{ bindExplicitly?: boolean }} integration - the tool's `_integration`
 * @returns {boolean}
 */
function bindingOffersAction(binding, action, integration) {
  if (Array.isArray(binding.actions)) return binding.actions.includes(action);
  return !integration.bindExplicitly;
}

/**
 * Run an integration tool. `params` is what `runTool` received: the model's
 * arguments plus iHub's context keys.
 */
export async function runIntegrationTool(tool, params = {}, options = {}) {
  const { instanceId, action: actionName } = tool._integration;
  const resolved = await installedIntegrationService.resolve(instanceId, params.language || 'en');
  if (!resolved?.definition) {
    throw new Error(`Integration ${instanceId} is not installed or its definition is missing`);
  }
  if (resolved.incompatible) {
    throw new Error(
      `Integration ${instanceId} cannot run: its definition ${resolved.statusReason || 'is incompatible with this server version'}`
    );
  }
  if (resolved.blocked) {
    // A failed or pending migration, or an installation that needs a
    // review: its values are not served against the loaded definition.
    throw new Error(
      `Integration ${instanceId} cannot run: ${resolved.migration?.status || 'migration'} (${resolved.migration?.statusReason || 'see Admin → Integrations'})`
    );
  }
  if (resolved.instance.enabled === false) {
    throw new Error(`Integration ${instanceId} is disabled`);
  }
  if (!userMayUse(resolved.instance, params.user)) {
    throw new Error(`Integration ${instanceId} is not available to this user`);
  }
  const adapter = getProtocolAdapter(resolved.definition.protocol.type);
  const action =
    resolved.definition.actions.find(a => a.name === actionName) ||
    (adapter.dynamicActions ? { name: actionName, sideEffect: 'unknown' } : null);
  if (!action) throw new Error(`Integration ${instanceId} has no action ${actionName}`);

  const args = {};
  for (const [key, value] of Object.entries(params)) {
    if (CONTEXT_KEYS.has(key)) continue;
    args[key] = value;
  }

  let scope = null;
  const picked = params.integrationScopes?.[instanceId];
  if (typeof picked === 'string' && picked && picked !== ALL_SCOPE_ID) {
    scope = { id: picked, name: scopeNames.get(`${instanceId}:${picked}`) || picked };
  }

  // Calls and errors per action for the action detail's Usage (#2974).
  recordActionEvent(instanceId, actionName, 'call');
  try {
    const result = await adapter.run({
      definition: resolved.definition,
      instance: resolved.instance,
      document: resolved.document,
      security: resolved.security,
      action,
      args,
      context: { scope, user: params.user, chatId: params.chatId, params, tool, options }
    });
    if (result && typeof result === 'object' && result.error === true) {
      recordActionEvent(instanceId, actionName, 'error');
    }
    return result;
  } catch (error) {
    recordActionEvent(instanceId, actionName, 'error');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Scope providers (#3050): one per installation whose definition declares scopes.

/** `${instanceId}:${scopeId}` → display name, from the last listing. */
const scopeNames = new Map();
const registeredInstanceIds = new Set();
const SCOPE_LISTING_TTL_MS = 60_000;

function scopeProviderFor(resolved) {
  const { instance, definition, label } = resolved;
  const instanceId = instance.id;
  const adapter = getProtocolAdapter(definition.protocol.type);
  const scopeLabel = localized(definition.scopes.label, 'en', 'Scope');

  // The listing is one request to the system; it is asked for on every chat
  // turn (validateScope) and every menu opening, so it is kept for a minute.
  let listing = null;
  async function listRaw() {
    if (listing && Date.now() - listing.at < SCOPE_LISTING_TTL_MS) return listing.scopes;
    const scopes = await adapter.listScopes({
      definition,
      instance,
      document: resolved.document,
      security: resolved.security
    });
    for (const scope of scopes) scopeNames.set(`${instanceId}:${scope.id}`, scope.name);
    listing = { at: Date.now(), scopes };
    return scopes;
  }

  function fallbackList() {
    return [{ id: ALL_SCOPE_ID, name: `All (${scopeLabel})` }];
  }

  return {
    id: instanceId,
    name: label,
    action: 'search',
    // A user whose groups do not grant the installation gets none of its
    // tools, so the scope picker and the "limited to" note would be about nothing.
    appliesTo: ({ app, user }) =>
      Boolean(appBindingFor(app, instance)) && userMayUse(instance, user),
    describeForModel: scopeId => {
      if (!scopeId || scopeId === ALL_SCOPE_ID) return null;
      const name = scopeNames.get(`${instanceId}:${scopeId}`) || scopeId;
      return `${label}: ${scopeLabel} limited to "${name}".`;
    },
    async listScopes({ app, user }) {
      if (!userMayUse(instance, user)) {
        return {
          scopes: [],
          defaultScope: null,
          fixed: false,
          source: 'integration',
          hint: 'forbidden'
        };
      }
      const settings = appScopeSettings(app, instanceId, definition.id);
      let scopes;
      let hint;
      try {
        scopes = await listRaw();
      } catch (error) {
        logger.warn('Could not list integration scopes', {
          component: COMPONENT,
          instanceId,
          error: error.message
        });
        scopes = [];
        hint = error.message;
      }
      if (settings.pinnedScope) {
        const pinned = scopes.find(s => s.id === settings.pinnedScope) || {
          id: settings.pinnedScope,
          name: scopeNames.get(`${instanceId}:${settings.pinnedScope}`) || settings.pinnedScope
        };
        return { scopes: [pinned], defaultScope: pinned.id, fixed: true, source: 'app' };
      }
      if (scopes.length === 0) scopes = fallbackList();
      const defaultScope = pickDefaultScope(
        scopes.map(s => ({ ...s, userDefault: s.isDefault === true })),
        settings.defaultScope
      );
      return { scopes, defaultScope, fixed: false, source: 'integration', hint };
    },
    async validateScope({ scopeId, app, user }) {
      // Nothing to bind: the user gets no tool of this installation.
      if (!userMayUse(instance, user)) return { ok: true, scopeId: null, fixed: false };
      const settings = appScopeSettings(app, instanceId, definition.id);
      if (settings.pinnedScope) return { ok: true, scopeId: settings.pinnedScope, fixed: true };
      if (!scopeId) return { ok: true, scopeId: settings.defaultScope || null, fixed: false };
      if (scopeId === ALL_SCOPE_ID) return { ok: true, scopeId: null, fixed: false };
      let scopes = [];
      try {
        scopes = await listRaw();
      } catch {
        // When the portal cannot be asked, trust the pick: the action itself will fail visibly.
        return { ok: true, scopeId, fixed: false };
      }
      if (scopes.some(s => s.id === scopeId)) return { ok: true, scopeId, fixed: false };
      return {
        ok: false,
        code: 'INTEGRATION_SCOPE_NOT_ALLOWED',
        message: `"${scopeId}" is not a ${scopeLabel.toLowerCase()} of ${label}`,
        available: scopes.map(s => s.id)
      };
    }
  };
}

/**
 * (Re)register a scope provider for every enabled installation with scopes,
 * and drop the providers of installations that are gone or disabled.
 */
export async function syncIntegrationScopeProviders() {
  let resolvedAll = [];
  try {
    resolvedAll = await installedIntegrationService.resolveAllEnabled('en');
  } catch (error) {
    logger.error('Could not sync integration scope providers', { component: COMPONENT, error });
  }
  const wanted = new Set();
  for (const resolved of resolvedAll) {
    if (!resolved.definition.scopes) continue;
    // A native connector brings its own provider (it knows the system's
    // per-user listings); declarative protocols get the generic one.
    const adapter = getProtocolAdapter(resolved.definition.protocol.type);
    if (resolved.definition.protocol.type === 'script') {
      // The adapter's `scopeProvider` is sync and only sees a loaded module:
      // after a restart nothing has loaded it yet. A module that does not
      // load gets no provider and does not stop the others.
      try {
        await adapter.getConnectorFor(resolved.definition);
      } catch (error) {
        logger.warn('Integration connector module could not be loaded; no scope provider', {
          component: COMPONENT,
          instanceId: resolved.instance.id,
          definition: resolved.definition.id,
          error: error.message
        });
        continue;
      }
    }
    const own = adapter?.scopeProvider ? adapter.scopeProvider(resolved) : null;
    registerScopeProvider(own || scopeProviderFor(resolved));
    wanted.add(resolved.instance.id);
  }
  for (const id of registeredInstanceIds) {
    if (!wanted.has(id)) unregisterScopeProvider(id);
  }
  registeredInstanceIds.clear();
  for (const id of wanted) registeredInstanceIds.add(id);
  return [...wanted];
}
