// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The storage providers Office 365 (OneDrive / SharePoint), Google Drive and
 * Nextcloud as the built-in installed integrations hold them: any number of
 * installations of `com.intrafind/office365`, `com.intrafind/google-drive`
 * and `com.intrafind/nextcloud` (all `type: storage`), each with the OAuth
 * app's client id, the client secret as a credential reference, an optional
 * redirect URI and the provider's own settings.
 *
 * **The installation id is the provider id.** It names the provider in the
 * OAuth routes (`/api/integrations/<service>/auth?providerId=<id>`), in the
 * callback URL (`/api/integrations/<service>/<id>/callback`), in the users'
 * stored connections (`<userId>__<id>.json` in the service's token
 * directory), in project cloud documents (`ref.providerId`) and in the
 * Nextcloud embed plugin (`ihub_provider_id`). Migration V206 renamed every
 * installation to the provider id it had before, so none of these changed.
 *
 * The services (`Office365Service`, …), the file browser routes, the
 * `/api/auth/status` payload and the project cloud kinds read the providers
 * through here in the shape they always had (`{ id, type, displayName,
 * enabled, clientId, clientSecretRef, … }`).
 *
 * Kept free of service imports so the services, the routes and the
 * connectors can all read the installations without an import cycle.
 *
 * @module services/integrations/cloudStorageConfig
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import configCache from '../../configCache.js';
import tokenStorage from '../TokenStorageService.js';
import logger from '../../utils/logger.js';
import { buildPublicBaseUrl, getForwardedHost } from '../../utils/publicBaseUrl.js';
import { mayUseIntegration } from './integrationAccess.js';

/** Provider type → its built-in definition, token store service and fallback name. */
export const CLOUD_STORAGE_PROVIDERS = Object.freeze({
  office365: Object.freeze({
    type: 'office365',
    definitionId: 'com.intrafind/office365',
    /** The token store service the users' connections are filed under (also the route segment). */
    service: 'office365',
    displayName: 'Microsoft Office 365'
  }),
  googledrive: Object.freeze({
    type: 'googledrive',
    definitionId: 'com.intrafind/google-drive',
    service: 'googledrive',
    displayName: 'Google Drive'
  }),
  nextcloud: Object.freeze({
    type: 'nextcloud',
    definitionId: 'com.intrafind/nextcloud',
    service: 'nextcloud',
    displayName: 'Nextcloud'
  })
});

export const CLOUD_STORAGE_TYPES = Object.freeze(Object.keys(CLOUD_STORAGE_PROVIDERS));

/** The definition ids of the shipped storage providers. */
export const CLOUD_STORAGE_DEFINITION_IDS = Object.freeze(
  CLOUD_STORAGE_TYPES.map(type => CLOUD_STORAGE_PROVIDERS[type].definitionId)
);

/** The provider type of a definition id, or null. */
export function cloudStorageTypeOfDefinition(definitionId) {
  return (
    CLOUD_STORAGE_TYPES.find(type => CLOUD_STORAGE_PROVIDERS[type].definitionId === definitionId) ||
    null
  );
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function installedList() {
  try {
    return configCache.getIntegrations?.()?.data?.installed || [];
  } catch {
    return [];
  }
}

/**
 * Every installation of the three storage definitions, in file order,
 * enabled or not.
 * @param {string} [type] - only the installations of this provider type
 * @returns {object[]}
 */
export function listCloudStorageInstallations(type) {
  return installedList().filter(instance => {
    const instanceType = cloudStorageTypeOfDefinition(instance?.definition);
    return Boolean(instanceType && instance.id) && (!type || instanceType === type);
  });
}

/**
 * One storage installation by its id (the provider id).
 * @param {string} instanceId
 * @returns {object|null}
 */
export function getCloudStorageInstallation(instanceId) {
  if (!instanceId) return null;
  return listCloudStorageInstallations().find(instance => instance.id === instanceId) || null;
}

function displayNameOf(instance, spec) {
  const label = instance?.label;
  if (typeof label === 'string' && label.trim()) return label.trim();
  if (label && typeof label === 'object') {
    const first = label.en || Object.values(label).find(v => typeof v === 'string' && v);
    if (first) return first;
  }
  return spec.displayName;
}

/**
 * A provider in the shape the services and routes always read
 * (`platform.cloudStorage.providers[]` as it was), from an installation.
 * Secrets stay references: `clientSecretRef` is resolved by
 * `OAuthIntegrationBase._getProviderConfig`.
 *
 * @param {object} instance - installation of one of the three definitions
 * @returns {object|null}
 */
export function providerFromInstance(instance) {
  const type = cloudStorageTypeOfDefinition(instance?.definition);
  if (!type || !instance.id) return null;
  const spec = CLOUD_STORAGE_PROVIDERS[type];
  const values = instance.values || {};
  const provider = {
    id: instance.id,
    name: instance.id,
    displayName: displayNameOf(instance, spec),
    type,
    definition: spec.definitionId,
    enabled: instance.enabled !== false,
    clientId: text(values.clientId),
    clientSecretRef: text(values.clientSecretRef),
    redirectUri: text(values.redirectUri) || undefined,
    installationId: instance.id
  };
  if (type === 'office365') {
    provider.tenantId = text(values.tenantId);
    if (text(values.siteUrl)) provider.siteUrl = text(values.siteUrl);
    if (text(values.driveId)) provider.driveId = text(values.driveId);
    provider.sources = {
      personalDrive: values.sourcePersonalDrive !== false,
      followedSites: values.sourceFollowedSites !== false,
      teams: values.sourceTeams !== false
    };
  } else if (type === 'googledrive') {
    provider.sources = {
      myDrive: values.sourceMyDrive !== false,
      sharedDrives: values.sourceSharedDrives !== false,
      sharedWithMe: values.sourceSharedWithMe !== false
    };
  } else if (type === 'nextcloud') {
    provider.serverUrl = text(values.serverUrl);
  }
  return provider;
}

/**
 * Every configured storage provider, enabled or not, in the shape of the
 * former `platform.cloudStorage.providers`.
 * @returns {object[]}
 */
export function listCloudStorageProviders() {
  return listCloudStorageInstallations().map(providerFromInstance).filter(Boolean);
}

/**
 * The provider a request names, by its id (the installation id) and, when
 * known, its type.
 * @param {string} providerId
 * @param {string} [type]
 * @returns {object|null}
 */
export function findCloudStorageProvider(providerId, type) {
  if (!providerId) return null;
  const instance = getCloudStorageInstallation(providerId);
  const provider = providerFromInstance(instance);
  if (!provider || (type && provider.type !== type)) return null;
  return provider;
}

/**
 * Whether the user's groups grant the installation behind a provider
 * (`permissions.integrations`: `*`, the installation id, its definition id or
 * `type:storage`; see `integrationAccess.js`). Fails closed: an unknown
 * provider is not granted.
 *
 * @param {Object|null|undefined} user - Enhanced user; none is the anonymous principal
 * @param {{ installationId?: string }|null} provider - from {@link listCloudStorageProviders}
 * @returns {boolean}
 */
export function mayUseCloudStorage(user, provider) {
  if (!provider?.installationId) return false;
  const instance = installedList().find(entry => entry?.id === provider.installationId);
  return Boolean(instance) && mayUseIntegration(instance, user);
}

/**
 * Whether the user may use the provider a request names (by provider id and
 * type). False for an unknown provider.
 * @param {Object|null|undefined} user
 * @param {string} providerId
 * @param {string} [type]
 * @returns {boolean}
 */
export function mayUseCloudStorageProvider(user, providerId, type) {
  return mayUseCloudStorage(user, findCloudStorageProvider(providerId, type));
}

/**
 * The providers a user may use: every configured provider, enabled or not,
 * whose installation the user's groups grant.
 * @param {Object|null|undefined} user
 * @returns {object[]}
 */
export function listCloudStorageProvidersFor(user) {
  return listCloudStorageProviders().filter(provider => mayUseCloudStorage(user, provider));
}

/**
 * The former `platform.cloudStorage` as `/api/auth/status` sends it to the
 * client (no secrets): the providers the user's groups grant
 * (`permissions.integrations`), and enabled while one of them is. `id` is the
 * installation id and `definition` its definition id, so the chat can tell
 * which providers an app binds (`shared/storageBindings.js`).
 *
 * @param {Object|null|undefined} user - The requesting user; none is the anonymous principal
 * @returns {{ enabled: boolean, providers: Array<{ id: string, name: string, displayName: string, type: string, definition: string, enabled: boolean }> }}
 */
export function cloudStorageStatus(user) {
  const providers = listCloudStorageProvidersFor(user).map(p => ({
    id: p.id,
    name: p.name,
    displayName: p.displayName,
    type: p.type,
    definition: p.definition,
    enabled: p.enabled
  }));
  return { enabled: providers.some(p => p.enabled), providers };
}

/**
 * Whether a provider is enabled and has what its OAuth flow needs: the client
 * id and secret reference, plus the tenant (Office 365) or the server URL
 * (Nextcloud).
 * @param {object|null} provider - from {@link providerFromInstance}
 * @returns {boolean}
 */
export function isCloudStorageProviderConfigured(provider) {
  if (!provider || !provider.enabled || !provider.clientId || !provider.clientSecretRef) {
    return false;
  }
  if (provider.type === 'office365') return Boolean(provider.tenantId);
  if (provider.type === 'nextcloud') return Boolean(provider.serverUrl);
  return true;
}

/**
 * The path a provider sends the browser back to, below the deployment's base
 * URL: `/api/integrations/<service>/<installation id>/callback`.
 * @param {string} type - `office365` | `googledrive` | `nextcloud`
 * @param {string} providerId - the installation id
 * @returns {string}
 */
export function cloudStorageCallbackPath(type, providerId) {
  const service = CLOUD_STORAGE_PROVIDERS[type]?.service || type;
  return `/api/integrations/${service}/${encodeURIComponent(providerId)}/callback`;
}

/**
 * The redirect URI of one OAuth flow, the way Jira derives it (#3079): the
 * installation's configured `redirectUri`, or — when it is empty — derived
 * from the request the way the browser sees it: scheme and host from the
 * `X-Forwarded-Proto` / `X-Forwarded-Host` headers of a trusted proxy (else
 * the request's own), the base path (`X-Forwarded-Prefix`), then
 * {@link cloudStorageCallbackPath}. The authorize redirect and the token
 * exchange must send the same value; the callback arrives at the URL derived
 * for the authorize step, so deriving it again from that request gives the
 * same URL.
 *
 * @param {import('express').Request|null|undefined} req
 * @param {{ id: string, type: string, redirectUri?: string }} provider
 * @returns {string}
 * @throws {Error} when nothing is configured and the request has no host
 *
 * @example
 *   // iHub at https://ihub.example.com/ihub, installation "nextcloud-hq"
 *   resolveCloudStorageRedirectUri(req, { id: 'nextcloud-hq', type: 'nextcloud' });
 *   // → https://ihub.example.com/ihub/api/integrations/nextcloud/nextcloud-hq/callback
 */
export function resolveCloudStorageRedirectUri(req, provider) {
  if (text(provider?.redirectUri)) return text(provider.redirectUri);
  if (!req || !getForwardedHost(req)) {
    throw new Error(
      `No redirect URI configured for the storage provider "${provider?.id}" and none can be derived from the request (no host)`
    );
  }
  return `${buildPublicBaseUrl(req)}${cloudStorageCallbackPath(provider.type, provider.id)}`;
}

/**
 * The users who connected a provider: one token file per user under
 * `<contents>/integrations/<service>/`, named `<userId>__<providerId>.json`
 * (or `<userId>.json` from before provider ids were part of the name; such a
 * file counts for every installation of the type, as the token store falls
 * back to it for each of them).
 * @param {string} type
 * @param {string} providerId - the installation id
 * @returns {Promise<Array<{ userId: string, createdAt: string|null, expiresAt: string|null, expired: boolean }>>}
 */
export async function listCloudStorageConnections(type, providerId) {
  const spec = CLOUD_STORAGE_PROVIDERS[type];
  if (!spec || !providerId) return [];
  const dir = path.join(tokenStorage.storageBasePath, spec.service);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const stem = file.slice(0, -'.json'.length);
    const at = stem.indexOf('__');
    const userId = at > 0 ? stem.slice(0, at) : stem;
    const fileProviderId = at > 0 ? stem.slice(at + 2) : null;
    if (!userId) continue;
    if (fileProviderId && fileProviderId !== providerId) continue;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    } catch (error) {
      logger.warn('Unreadable cloud storage token file skipped', {
        component: 'CloudStorageConfig',
        service: spec.service,
        file,
        error: error.message
      });
      continue;
    }
    const expiresAt = raw?.expiresAt || null;
    let hasRefreshToken = true;
    try {
      hasRefreshToken = Boolean(
        tokenStorage.decryptTokens(raw, userId, spec.service)?.refreshToken
      );
    } catch {
      /* unreadable payload: report the connection as the file describes it */
    }
    out.push({
      userId,
      createdAt: raw?.createdAt || null,
      expiresAt,
      expired: Boolean(expiresAt && new Date(expiresAt) <= new Date() && !hasRefreshToken)
    });
  }
  return out.sort((a, b) => a.userId.localeCompare(b.userId));
}
