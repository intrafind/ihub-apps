// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a signed-in user sees of the installed integrations
 * (`GET /api/integrations`, concept `2026-10-20 Unified Integrations`
 * 03 §7.1 and 04 §4): every enabled installation their groups allow — never
 * another one — with its capabilities, its enabled actions and their side
 * effects, and how it runs for this user:
 *
 * | `connection.mode`  | `connection.status`                                  | Meaning |
 * | ------------------ | ---------------------------------------------------- | ------- |
 * | `personal`         | `connected` / `not_connected` / `needs_reconnect`    | The user signs in with their own account (OAuth) |
 * | `sso`              | `sso`                                                | Runs with the user's iHub sign-in (iFinder, iAssistant) |
 * | `service_account`  | `service_account`                                    | Runs as an account the admin configured |
 * | `shared_key`       | `shared_key`                                         | Runs with an API key the admin configured |
 * | `none`             | `none`                                               | Needs no sign-in at all |
 * | any                | `unavailable`                                        | Cannot be used until an admin acts (`reason`) |
 *
 * `unavailable` (#2922) is decided here, from the same sources the admin list
 * reads: the adapter's live status (`unhealthy` → `unreachable`, or
 * `credential_rejected` when the last error says the shared key or token was
 * refused), a credential reference the credential store does not hold
 * (`credential_missing`), and a per-user sign-in that is not set up
 * (`not_configured`).
 *
 * Each entry also names the apps the user may open that use it (`apps`), the
 * definition's `categories`, and, for a shared account or key, the user's
 * groups that grant it (`connection.sharedWith`).
 *
 * The status comes from the connection index (`IntegrationConnectionService.resolve`);
 * no vendor is called and no token leaves the server.
 *
 * @module services/integrations/userIntegrations
 */
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import credentialService from '../CredentialService.js';
import { isToolSelected } from '../../utils/toolSelection.js';
import { sortWebSearchEngines, WEB_SEARCH_TYPE } from '../search/webSearchEngines.js';
import installedIntegrationService from './InstalledIntegrationService.js';
import {
  ALL_INTEGRATIONS,
  integrationGrantKeys,
  mayUseIntegration,
  typeOfInstallation
} from './integrationAccess.js';
import { localized } from './definitions/installedValues.js';
import { describeInstallation } from './auth/connectionProviders.js';
import {
  connectionIdFor,
  getIntegrationConnectionService
} from './auth/IntegrationConnectionService.js';
import { INTEGRATION_AUTH_REASONS } from './auth/integrationAuthRequired.js';

const COMPONENT = 'UserIntegrations';

/** `connection.mode` values. */
export const CONNECTION_MODES = Object.freeze({
  PERSONAL: 'personal',
  SSO: 'sso',
  SERVICE_ACCOUNT: 'service_account',
  SHARED_KEY: 'shared_key',
  NONE: 'none'
});

/** `connection.status` values. */
export const CONNECTION_STATUSES = Object.freeze({
  CONNECTED: 'connected',
  NOT_CONNECTED: 'not_connected',
  NEEDS_RECONNECT: 'needs_reconnect',
  SSO: 'sso',
  SERVICE_ACCOUNT: 'service_account',
  SHARED_KEY: 'shared_key',
  NONE: 'none',
  UNAVAILABLE: 'unavailable'
});

/** Why an integration is `unavailable`: each one needs an admin. */
export const UNAVAILABLE_REASONS = Object.freeze({
  /** The adapter reports the system unreachable (the admin list's "Unreachable"). */
  UNREACHABLE: 'unreachable',
  /** Unreachable, and the last error says the shared key or token was refused or expired. */
  CREDENTIAL_REJECTED: 'credential_rejected',
  /** The installation names a credential the credential store does not hold. */
  CREDENTIAL_MISSING: 'credential_missing',
  /** Per-user sign-in that is switched off or not set up (no OAuth client). */
  NOT_CONFIGURED: 'not_configured'
});

/** A last error that says the shared credential was refused (the text is never sent). */
const REJECTED_CREDENTIAL =
  /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[\s_-]?(api[\s_-]?)?(key|token|credential)|expired/i;

/** Sensitive install fields that hold an API key (rather than an account's password). */
const API_KEY_FIELD = /(api.?key|token|key$)/i;

/** Order in which side effects are listed. */
const EFFECT_ORDER = ['read', 'write', 'destructive', 'unknown'];

/**
 * How an installation that takes no per-user connection runs: with a service
 * account, a shared API key, or nothing at all. Read from the installation's
 * sign-in mode and the definition's sensitive install fields; never from a
 * secret.
 *
 * @param {Object} instance - Installed integration
 * @param {Object|null} definition - Its definition
 * @returns {'service_account'|'shared_key'|'none'}
 */
export function sharedModeOf(instance, definition) {
  const mode = instance?.auth?.mode || definition?.auth?.default || 'none';
  if (mode === 'service-account' || mode === 'oauth-client') {
    return CONNECTION_MODES.SERVICE_ACCOUNT;
  }
  const oauthFields = new Set(
    [definition?.auth?.oauthUser?.field, definition?.auth?.oauthClient?.field].filter(Boolean)
  );
  // A secret value or a reference into the credential store.
  const secrets = (definition?.install || []).filter(
    field => (field?.sensitive || field?.type === 'credential') && !oauthFields.has(field.key)
  );
  if (secrets.length === 0) return CONNECTION_MODES.NONE;
  return secrets.some(field => API_KEY_FIELD.test(field.key))
    ? CONNECTION_MODES.SHARED_KEY
    : CONNECTION_MODES.SERVICE_ACCOUNT;
}

/** The host a user signs in at (from the issuer URL), or null. */
function signInHostOf(issuer) {
  if (typeof issuer !== 'string' || !issuer) return null;
  try {
    return new URL(issuer).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Why an installation that runs without a personal sign-in cannot be used
 * right now, or null. Pure.
 *
 * @param {Object} [params]
 * @param {{unhealthy?: boolean, lastError?: string|null}|null} [params.live] - The adapter's live status
 * @param {boolean} [params.credentialMissing=false]
 * @returns {string|null} One of {@link UNAVAILABLE_REASONS}, or null
 *
 * @example
 * unavailableReasonOf({ live: { unhealthy: true, lastError: 'HTTP 401 Unauthorized' } });
 * // → 'credential_rejected'
 */
export function unavailableReasonOf({ live = null, credentialMissing = false } = {}) {
  if (credentialMissing) return UNAVAILABLE_REASONS.CREDENTIAL_MISSING;
  if (!live?.unhealthy) return null;
  return REJECTED_CREDENTIAL.test(String(live.lastError || ''))
    ? UNAVAILABLE_REASONS.CREDENTIAL_REJECTED
    : UNAVAILABLE_REASONS.UNREACHABLE;
}

/**
 * The `connection` block of a listing entry. Pure: everything it needs is
 * passed in, which keeps it testable without the connection service.
 *
 * @param {Object} params
 * @param {Object|null} params.descriptor - `describeInstallation(id)`
 * @param {Object|null} params.resolved - `IntegrationConnectionService.resolve(...)`
 * @param {Object|null} params.record - The user's connection record, if any
 * @param {Object} params.instance
 * @param {Object|null} params.definition
 * @param {{unhealthy?: boolean, lastError?: string|null}|null} [params.live] - The adapter's live status
 * @param {boolean} [params.credentialMissing=false] - A credential the installation names is not in the store
 * @param {boolean|null} [params.renewable=null] - Connected: whether iHub holds a refresh token
 * @param {Array<{id: string, name: string}>} [params.sharedWith=[]] - The user's groups that grant it
 * @returns {Object}
 *
 * @example
 * connectionStatusOf({ descriptor: { kind: 'sso' }, resolved: null, record: null, instance, definition });
 * // → { mode: 'sso', status: 'sso', reason: null, account: null, … , connectable: false }
 */
export function connectionStatusOf({
  descriptor,
  resolved,
  record,
  instance,
  definition,
  live = null,
  credentialMissing = false,
  renewable = null,
  sharedWith = []
}) {
  const base = {
    reason: null,
    account: null,
    scopes: [],
    connectedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    signInHost: null,
    connectable: false,
    renewable: null,
    sharedWith: []
  };
  if (descriptor?.kind !== 'oauth-user') {
    let mode;
    if (descriptor?.kind === 'sso') mode = CONNECTION_MODES.SSO;
    else if (descriptor?.kind === 'service-account') mode = CONNECTION_MODES.SERVICE_ACCOUNT;
    else mode = sharedModeOf(instance, definition);
    const shared = {
      ...base,
      mode,
      status: mode,
      // Who shares the account or key with this user; SSO and "none" share nothing.
      sharedWith:
        mode === CONNECTION_MODES.SERVICE_ACCOUNT || mode === CONNECTION_MODES.SHARED_KEY
          ? sharedWith
          : []
    };
    const unavailable = unavailableReasonOf({ live, credentialMissing });
    return unavailable
      ? { ...shared, status: CONNECTION_STATUSES.UNAVAILABLE, reason: unavailable }
      : shared;
  }
  const personal = {
    ...base,
    mode: CONNECTION_MODES.PERSONAL,
    signInHost: signInHostOf(record?.issuer || descriptor.issuer),
    connectable: descriptor.enabled !== false && descriptor.configured !== false
  };
  if (!personal.connectable) {
    return {
      ...personal,
      status: CONNECTION_STATUSES.UNAVAILABLE,
      reason: UNAVAILABLE_REASONS.NOT_CONFIGURED
    };
  }
  if (resolved?.ok) {
    return {
      ...personal,
      status: CONNECTION_STATUSES.CONNECTED,
      account: record?.externalAccount?.label || null,
      scopes: Array.isArray(record?.scopesGranted) ? record.scopesGranted : [],
      connectedAt: record?.createdAt || null,
      expiresAt: record?.expiresAt || null,
      lastUsedAt: record?.lastUsedAt || null,
      renewable: typeof renewable === 'boolean' ? renewable : null
    };
  }
  const reason = resolved?.error?.reason || INTEGRATION_AUTH_REASONS.NOT_CONNECTED;
  if (reason === INTEGRATION_AUTH_REASONS.NOT_CONNECTED) {
    return { ...personal, status: CONNECTION_STATUSES.NOT_CONNECTED, reason };
  }
  return {
    ...personal,
    status: CONNECTION_STATUSES.NEEDS_RECONNECT,
    reason,
    account: record?.externalAccount?.label || null,
    scopes: Array.isArray(record?.scopesGranted) ? record.scopesGranted : [],
    lastUsedAt: record?.lastUsedAt || null
  };
}

/**
 * Whether the installation names a credential the credential store does not
 * hold: its shared sign-in (`auth.credentialRef`) or a required `credential`
 * install field with a value. Only the existence of the profile is read.
 *
 * @param {Object} instance
 * @param {Object|null} definition
 * @returns {boolean}
 */
export function credentialMissingOf(instance, definition) {
  const refs = [];
  const mode = instance?.auth?.mode;
  if ((mode === 'service-account' || mode === 'oauth-client') && instance.auth.credentialRef) {
    refs.push(instance.auth.credentialRef);
  }
  for (const field of definition?.install || []) {
    if (field?.type !== 'credential' || !field.required) continue;
    const value = instance?.values?.[field.key];
    if (typeof value === 'string' && value) refs.push(value);
  }
  return refs.some(ref => {
    try {
      return !credentialService.has(ref);
    } catch {
      return false;
    }
  });
}

/**
 * The user's groups that grant an installation by name — its id, else its
 * definition id, else its type key: the most specific level any of the
 * user's groups grants. Empty when only `*` grants it (everybody has it,
 * there is no group to name).
 *
 * @param {Object} instance
 * @param {Object} user - `{ groups }`
 * @param {string} language
 * @returns {Array<{id: string, name: string}>}
 */
export function sharedWithOf(instance, user, language) {
  const userGroups = Array.isArray(user?.groups) ? user.groups : [];
  if (userGroups.length === 0) return [];
  let config = {};
  try {
    config = configCache.getGroups?.()?.data?.groups || {};
  } catch {
    config = {};
  }
  const grants = id => {
    const list = config[id]?.permissions?.integrations;
    if (list instanceof Set) return list;
    return new Set(Array.isArray(list) ? list : []);
  };
  for (const key of integrationGrantKeys(instance)) {
    if (key === ALL_INTEGRATIONS) continue;
    const groups = userGroups.filter(id => grants(id).has(key));
    if (groups.length > 0) {
      return groups.map(id => ({ id, name: localized(config[id]?.name, language, id) || id }));
    }
  }
  return [];
}

/**
 * The enabled actions of each installation, from the tool list the models
 * are offered (`toolLoader.loadTools`), grouped by installation id, and the
 * tools themselves (to find the apps that name them in `app.tools`).
 *
 * @param {string} language
 * @returns {Promise<{actions: Map<string, Array<{name: string, title: string, description: string, sideEffect: string}>>, tools: Map<string, Object[]>}>}
 */
async function actionsByInstallation(language) {
  const actions = new Map();
  const toolsById = new Map();
  let tools = [];
  try {
    const { loadTools } = await import('../../toolLoader.js');
    tools = await loadTools(language);
  } catch (error) {
    logger.warn('Could not load the tools for the integrations listing', {
      component: COMPONENT,
      error: error.message
    });
    return { actions, tools: toolsById };
  }
  for (const tool of tools) {
    const marker = tool?._integration;
    if (!marker?.instanceId) continue;
    const list = actions.get(marker.instanceId) || [];
    list.push({
      name: String(marker.action || tool.id),
      title: String(marker.actionTitle || marker.action || tool.name || tool.id),
      description: typeof tool.description === 'string' ? tool.description.split('\n\n')[0] : '',
      sideEffect: tool.sideEffect || 'unknown'
    });
    actions.set(marker.instanceId, list);
    toolsById.set(marker.instanceId, [...(toolsById.get(marker.instanceId) || []), tool]);
  }
  return { actions, tools: toolsById };
}

/** The distinct side effects of a list of actions, in a stable order. */
export function effectsOf(actions) {
  const present = new Set((actions || []).map(action => action.sideEffect || 'unknown'));
  return EFFECT_ORDER.filter(effect => present.has(effect));
}

/** An http(s) icon URL of the definition, or null (companion icons are not served yet). */
function iconOf(definition) {
  const icon = definition?.icon;
  return typeof icon === 'string' && /^https?:\/\//i.test(icon) ? icon : null;
}

/** The apps the user may open (enabled ones only); an empty list when they cannot be read. */
async function appsOfUser(user) {
  try {
    const { data } = await configCache.getAppsForUser(user, configCache.getPlatform?.() || {});
    return (Array.isArray(data) ? data : []).filter(app => app && app.enabled !== false);
  } catch (error) {
    logger.warn('Could not read the apps for the integrations listing', {
      component: COMPONENT,
      error: error.message
    });
    return [];
  }
}

/**
 * Whether an app uses an installation: it binds it (`app.integrations`: its
 * id, its definition id or its type key), names one of its tools in
 * `app.tools`, or — a web search engine — names it in `app.websearch.provider`
 * (`auto` uses the engine `autoEngineId`).
 *
 * @param {Object} app
 * @param {Object} instance
 * @param {Object[]} tools - The installation's tools
 * @param {Function} bindingKeyFor - `integrationTools.bindingKeyFor`
 * @param {string|null} autoEngineId - The web search engine `auto` picks for this user
 * @returns {boolean}
 */
export function appUsesIntegration(app, instance, tools, bindingKeyFor, autoEngineId = null) {
  if (bindingKeyFor(app, instance) !== null) return true;
  if (Array.isArray(app?.tools) && app.tools.length > 0) {
    if ((tools || []).some(tool => isToolSelected(tool, app.tools))) return true;
  }
  if (app?.websearch?.enabled === true && typeOfInstallation(instance) === WEB_SEARCH_TYPE) {
    const provider = app.websearch.provider || 'auto';
    if (provider === instance.id) return true;
    if (provider === 'auto' && autoEngineId === instance.id) return true;
  }
  return false;
}

/**
 * One listing entry.
 *
 * @param {Object} resolved - `installedIntegrationService.resolve(...)`
 * @param {Object} user
 * @param {Object} context
 * @param {Array} context.actions - The installation's enabled actions
 * @param {Array<{id: string, name: string}>} context.apps - The user's apps that use it
 * @param {Object|null} context.live - The adapter's live status
 * @returns {Promise<Object>}
 */
async function entryFor(resolved, user, { actions, apps, live }) {
  const { instance, definition, label } = resolved;
  const language = resolved.language;
  const descriptor = await describeInstallation(instance.id).catch(() => null);
  let resolvedConnection = null;
  let record = null;
  let renewable = null;
  if (descriptor?.kind === 'oauth-user') {
    const principal = { type: 'user', id: String(user.id) };
    const connections = getIntegrationConnectionService();
    resolvedConnection = await connections
      .resolve(principal, instance.id)
      .catch(error => ({ ok: false, error }));
    record = resolvedConnection?.ok
      ? resolvedConnection.connection
      : await connections.getConnection(connectionIdFor(instance.id, principal)).catch(() => null);
    // "Connected as …": read once from the provider, then kept on the record.
    if (resolvedConnection?.ok && record && !record.externalAccount?.label) {
      const label = await connections
        .ensureAccountLabel({ installationId: instance.id, userId: principal.id })
        .catch(() => null);
      if (label) record = { ...record, externalAccount: { ...record.externalAccount, label } };
    }
    // Whether the access is renewed without the user (a refresh token is
    // held), so "expires" is not shown for a token that renews itself. Only
    // the presence is read; no token leaves this function.
    if (resolvedConnection?.ok && descriptor.secret?.read && descriptor.secret?.view) {
      try {
        const view = descriptor.secret.view(await descriptor.secret.read(principal.id));
        renewable = view ? Boolean(view.refreshToken) : null;
      } catch {
        renewable = null;
      }
    }
  }
  return {
    id: instance.id,
    definition: definition.id,
    type: typeOfInstallation(instance),
    protocol: definition.protocol?.type || null,
    name: label,
    description:
      localized(instance.description, language) || localized(definition.description, language),
    icon: iconOf(definition),
    categories: Array.isArray(definition.categories) ? [...definition.categories] : [],
    capabilities: Array.isArray(definition.capabilities) ? [...definition.capabilities] : [],
    actions,
    effects: effectsOf(actions),
    apps,
    connection: connectionStatusOf({
      descriptor,
      resolved: resolvedConnection,
      record,
      instance,
      definition,
      live,
      credentialMissing: credentialMissingOf(instance, definition),
      renewable,
      sharedWith: sharedWithOf(instance, user, language)
    })
  };
}

/**
 * The live status the admin list shows for an installation (MCP, A2A), or null.
 *
 * @param {Function|null} getProtocolAdapter
 * @param {Object} resolved
 * @returns {{unhealthy?: boolean, lastError?: string|null}|null}
 */
function liveStatusOf(getProtocolAdapter, resolved) {
  try {
    const adapter = getProtocolAdapter?.(resolved.definition?.protocol?.type);
    return typeof adapter?.status === 'function' ? adapter.status(resolved.instance) || null : null;
  } catch {
    return null;
  }
}

/**
 * The installations a user may use, with capabilities, actions, the apps
 * that use them and connection status. Disabled installations, ones whose
 * definition cannot run, and ones the user's groups do not grant are left out.
 *
 * @param {Object} params
 * @param {Object} params.user - The signed-in user (`req.user`)
 * @param {string} [params.language='en']
 * @param {string} [params.only] - Just this installation id
 * @returns {Promise<Object[]>}
 */
export async function listUserIntegrations({ user, language = 'en', only } = {}) {
  let resolvedAll = [];
  try {
    resolvedAll = await installedIntegrationService.resolveAllEnabled(language);
  } catch (error) {
    logger.error('Could not resolve the installed integrations', {
      component: COMPONENT,
      error: error.message
    });
    return [];
  }
  const granted = resolvedAll.filter(resolved => mayUseIntegration(resolved.instance, user));
  const visible = granted.filter(resolved => !only || resolved.instance.id === only);
  if (visible.length === 0) return [];
  // The engine `websearch.provider: "auto"` picks for this user: the first one they may use.
  const autoEngineId =
    sortWebSearchEngines(
      granted
        .map(resolved => resolved.instance)
        .filter(instance => typeOfInstallation(instance) === WEB_SEARCH_TYPE)
    )[0]?.id || null;
  const [{ actions, tools }, userApps, runtime] = await Promise.all([
    actionsByInstallation(language),
    appsOfUser(user),
    // Loaded lazily, like the tool loader: both reach the protocol adapters.
    Promise.all([import('./integrationTools.js'), import('./protocols/index.js')]).catch(error => {
      logger.warn('Could not load the integration runtime for the listing', {
        component: COMPONENT,
        error: error.message
      });
      return null;
    })
  ]);
  const bindingKeyFor = runtime?.[0]?.bindingKeyFor || (() => null);
  const getProtocolAdapter = runtime?.[1]?.getProtocolAdapter || null;
  const out = [];
  for (const resolved of visible) {
    const { instance } = resolved;
    try {
      const apps = userApps
        .filter(app =>
          appUsesIntegration(app, instance, tools.get(instance.id), bindingKeyFor, autoEngineId)
        )
        .map(app => ({ id: app.id, name: localized(app.name, language, app.id) || app.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
      out.push(
        await entryFor({ ...resolved, language }, user, {
          actions: actions.get(instance.id) || [],
          apps,
          live: liveStatusOf(getProtocolAdapter, resolved)
        })
      );
    } catch (error) {
      logger.warn('Could not describe an integration for the user', {
        component: COMPONENT,
        integration: instance.id,
        error: error.message
      });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * One installation as {@link listUserIntegrations} lists it, or null when the
 * user may not see it (unknown, disabled, not granted).
 *
 * @param {Object} params
 * @param {Object} params.user
 * @param {string} params.installationId
 * @param {string} [params.language='en']
 * @returns {Promise<Object|null>}
 */
export async function getUserIntegration({ user, installationId, language = 'en' }) {
  const [entry] = await listUserIntegrations({ user, language, only: installationId });
  return entry || null;
}
