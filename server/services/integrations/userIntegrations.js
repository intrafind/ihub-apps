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
 *
 * The status comes from the connection index (`IntegrationConnectionService.resolve`);
 * no vendor is called and no token leaves the server.
 *
 * @module services/integrations/userIntegrations
 */
import logger from '../../utils/logger.js';
import installedIntegrationService from './InstalledIntegrationService.js';
import { mayUseIntegration, typeOfInstallation } from './integrationAccess.js';
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
  NONE: 'none'
});

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
  const secrets = (definition?.install || []).filter(
    field => field?.sensitive && !oauthFields.has(field.key)
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
 * The `connection` block of a listing entry. Pure: everything it needs is
 * passed in, which keeps it testable without the connection service.
 *
 * @param {Object} params
 * @param {Object|null} params.descriptor - `describeInstallation(id)`
 * @param {Object|null} params.resolved - `IntegrationConnectionService.resolve(...)`
 * @param {Object|null} params.record - The user's connection record, if any
 * @param {Object} params.instance
 * @param {Object|null} params.definition
 * @returns {Object}
 *
 * @example
 * connectionStatusOf({ descriptor: { kind: 'sso' }, resolved: null, record: null, instance, definition });
 * // → { mode: 'sso', status: 'sso', reason: null, account: null, … , connectable: false }
 */
export function connectionStatusOf({ descriptor, resolved, record, instance, definition }) {
  const base = {
    reason: null,
    account: null,
    scopes: [],
    connectedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    signInHost: null,
    connectable: false
  };
  if (descriptor?.kind === 'sso') {
    return { ...base, mode: CONNECTION_MODES.SSO, status: CONNECTION_STATUSES.SSO };
  }
  if (descriptor?.kind === 'service-account') {
    return {
      ...base,
      mode: CONNECTION_MODES.SERVICE_ACCOUNT,
      status: CONNECTION_STATUSES.SERVICE_ACCOUNT
    };
  }
  if (descriptor?.kind !== 'oauth-user') {
    const mode = sharedModeOf(instance, definition);
    return { ...base, mode, status: mode };
  }
  const personal = {
    ...base,
    mode: CONNECTION_MODES.PERSONAL,
    signInHost: signInHostOf(record?.issuer || descriptor.issuer),
    connectable: descriptor.enabled !== false && descriptor.configured !== false
  };
  if (resolved?.ok) {
    return {
      ...personal,
      status: CONNECTION_STATUSES.CONNECTED,
      account: record?.externalAccount?.label || null,
      scopes: Array.isArray(record?.scopesGranted) ? record.scopesGranted : [],
      connectedAt: record?.createdAt || null,
      expiresAt: record?.expiresAt || null,
      lastUsedAt: record?.lastUsedAt || null
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
    scopes: Array.isArray(record?.scopesGranted) ? record.scopesGranted : []
  };
}

/**
 * The enabled actions of each installation, from the tool list the models
 * are offered (`toolLoader.loadTools`), grouped by installation id.
 *
 * @param {string} language
 * @returns {Promise<Map<string, Array<{name: string, title: string, description: string, sideEffect: string}>>>}
 */
async function actionsByInstallation(language) {
  const byId = new Map();
  let tools = [];
  try {
    const { loadTools } = await import('../../toolLoader.js');
    tools = await loadTools(language);
  } catch (error) {
    logger.warn('Could not load the tools for the integrations listing', {
      component: COMPONENT,
      error: error.message
    });
    return byId;
  }
  for (const tool of tools) {
    const marker = tool?._integration;
    if (!marker?.instanceId) continue;
    const list = byId.get(marker.instanceId) || [];
    list.push({
      name: String(marker.action || tool.id),
      title: String(marker.actionTitle || marker.action || tool.name || tool.id),
      description: typeof tool.description === 'string' ? tool.description.split('\n\n')[0] : '',
      sideEffect: tool.sideEffect || 'unknown'
    });
    byId.set(marker.instanceId, list);
  }
  return byId;
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

/**
 * One listing entry.
 *
 * @param {Object} resolved - `installedIntegrationService.resolve(...)`
 * @param {Object} user
 * @param {Array} actions - The installation's enabled actions
 * @returns {Promise<Object>}
 */
async function entryFor(resolved, user, actions) {
  const { instance, definition, label } = resolved;
  const descriptor = await describeInstallation(instance.id).catch(() => null);
  let resolvedConnection = null;
  let record = null;
  if (descriptor?.kind === 'oauth-user') {
    const principal = { type: 'user', id: String(user.id) };
    const connections = getIntegrationConnectionService();
    resolvedConnection = await connections
      .resolve(principal, instance.id)
      .catch(error => ({ ok: false, error }));
    record = resolvedConnection?.ok
      ? resolvedConnection.connection
      : await connections.getConnection(connectionIdFor(instance.id, principal)).catch(() => null);
  }
  const language = resolved.language;
  return {
    id: instance.id,
    definition: definition.id,
    type: typeOfInstallation(instance),
    protocol: definition.protocol?.type || null,
    name: label,
    description:
      localized(instance.description, language) || localized(definition.description, language),
    icon: iconOf(definition),
    capabilities: Array.isArray(definition.capabilities) ? [...definition.capabilities] : [],
    actions,
    effects: effectsOf(actions),
    connection: connectionStatusOf({
      descriptor,
      resolved: resolvedConnection,
      record,
      instance,
      definition
    })
  };
}

/**
 * The installations a user may use, with capabilities, actions and
 * connection status. Disabled installations, ones whose definition cannot
 * run, and ones the user's groups do not grant are left out.
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
  const visible = resolvedAll.filter(
    resolved =>
      (!only || resolved.instance.id === only) && mayUseIntegration(resolved.instance, user)
  );
  if (visible.length === 0) return [];
  const actions = await actionsByInstallation(language);
  const out = [];
  for (const resolved of visible) {
    try {
      out.push(
        await entryFor({ ...resolved, language }, user, actions.get(resolved.instance.id) || [])
      );
    } catch (error) {
      logger.warn('Could not describe an integration for the user', {
        component: COMPONENT,
        integration: resolved.instance.id,
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
