// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../../utils/logger.js';
import { RESERVED_TOOL_CONTEXT_KEYS } from '../../utils/toolCallContext.js';
import installedIntegrationService from './InstalledIntegrationService.js';
import { getProtocolAdapter } from './protocols/index.js';
import { localized } from './definitions/installedValues.js';
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

function toolFromAction(resolved, action, language) {
  const { instance, definition, label } = resolved;
  const title = action.title || action.name;
  const guidance = action.guidance ? `\n\n${action.guidance}` : '';
  return {
    id: action.toolId,
    name: `${label}: ${title}`,
    description: `${action.description || title}${guidance}`,
    parameters: action.parameters,
    type: 'integration',
    _integration: {
      instanceId: instance.id,
      instanceLabel: label,
      action: action.name,
      definition: definition.id,
      // A built-in that kept the tool id it had before (`iFinder_search`).
      fixedToolId: action.toolId !== `${instance.id}__${action.name}`
    },
    sideEffect: action.sideEffect,
    dataFlow: action.dataFlow,
    readOnly: action.sideEffect === 'read',
    examples: action.examples,
    sources: action.sources,
    instructions: localized(definition.instructions, language) || undefined
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
      const actions = await adapter.discoverActions({
        definition: resolved.definition,
        instance: resolved.instance,
        document: resolved.document,
        security: resolved.security,
        language: lang
      });
      for (const action of actions) {
        if (!action.available) continue;
        tools.push(toolFromAction(resolved, action, lang));
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

function userMayUse(instance, user) {
  const allowed = instance.allowedGroups || [];
  if (allowed.length === 0) return true;
  const groups = Array.isArray(user?.groups) ? user.groups : [];
  return groups.some(g => allowed.includes(g));
}

/** The installation ids an app binds (keys of `app.integrations` that are installed). */
export function boundInstanceIds(app) {
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object') return [];
  return Object.keys(bindings).filter(id => installedIntegrationService.get(id));
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
  for (const tool of allTools) {
    if (!isIntegrationTool(tool)) continue;
    const { instanceId, action } = tool._integration;
    const binding = bindings[instanceId];
    if (!binding) continue;
    const instance = installedIntegrationService.get(instanceId);
    if (!instance || instance.enabled === false) continue;
    if (!userMayUse(instance, context.user)) continue;
    // `actions` absent: every action; a list (even empty): only those. An
    // empty list binds the installation for its scopes and nothing else.
    if (Array.isArray(binding.actions) && !binding.actions.includes(action)) continue;
    out.push(tool);
  }
  return out;
}

/**
 * Run an integration tool. `params` is what `runTool` received: the model's
 * arguments plus iHub's context keys.
 */
export async function runIntegrationTool(tool, params = {}) {
  const { instanceId, action: actionName } = tool._integration;
  const resolved = await installedIntegrationService.resolve(instanceId, params.language || 'en');
  if (!resolved?.definition) {
    throw new Error(`Integration ${instanceId} is not installed or its definition is missing`);
  }
  if (resolved.instance.enabled === false) {
    throw new Error(`Integration ${instanceId} is disabled`);
  }
  if (!userMayUse(resolved.instance, params.user)) {
    throw new Error(`Integration ${instanceId} is not available to this user`);
  }
  const action = resolved.definition.actions.find(a => a.name === actionName);
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

  const adapter = getProtocolAdapter(resolved.definition.protocol.type);
  return adapter.run({
    definition: resolved.definition,
    instance: resolved.instance,
    document: resolved.document,
    security: resolved.security,
    action,
    args,
    context: { scope, user: params.user, chatId: params.chatId, params }
  });
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
    // A user outside the installation's groups gets none of its tools, so
    // the scope picker and the "limited to" note would be about nothing.
    appliesTo: ({ app, user }) =>
      Boolean(app?.integrations?.[instanceId]) && userMayUse(instance, user),
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
      const settings = appScopeSettings(app, instanceId);
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
      const settings = appScopeSettings(app, instanceId);
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
