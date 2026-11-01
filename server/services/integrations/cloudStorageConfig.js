// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cloud storage providers — Office 365 (OneDrive / SharePoint), Google
 * Drive and Nextcloud — as the built-in installed integrations hold them:
 * one singleton installation per provider type (`office365`, `googledrive`,
 * `nextcloud`), each with the OAuth app's client id, the client secret as a
 * credential reference, the redirect URI and the provider's own settings.
 *
 * The services (`Office365Service`, …), the file browser routes, the
 * `/api/auth/status` payload and the project cloud kinds read the providers
 * through here in the shape they always had (`{ id, type, displayName,
 * enabled, clientId, clientSecretRef, … }`), so nothing downstream changed:
 * the provider's `id` is the installation's `providerId` value — by default
 * the installation id, or the id the provider had before it was an
 * installation, so the callback URLs
 * (`/api/integrations/<type>/<providerId>/callback`), the stored user tokens
 * (`<userId>__<providerId>.json`) and the Nextcloud embed plugin's provider id
 * keep working.
 *
 * Kept free of service imports so the services, the routes and the
 * connectors can all read the installations without an import cycle.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import configCache from '../../configCache.js';
import tokenStorage from '../TokenStorageService.js';
import logger from '../../utils/logger.js';

/** Provider type → the built-in definition and its fixed installation id. */
export const CLOUD_STORAGE_PROVIDERS = Object.freeze({
  office365: Object.freeze({
    type: 'office365',
    definitionId: 'com.intrafind/office365',
    instanceId: 'office365',
    /** The token store service the users' connections are filed under. */
    service: 'office365',
    displayName: 'Microsoft Office 365'
  }),
  googledrive: Object.freeze({
    type: 'googledrive',
    definitionId: 'com.intrafind/google-drive',
    instanceId: 'googledrive',
    service: 'googledrive',
    displayName: 'Google Drive'
  }),
  nextcloud: Object.freeze({
    type: 'nextcloud',
    definitionId: 'com.intrafind/nextcloud',
    instanceId: 'nextcloud',
    service: 'nextcloud',
    displayName: 'Nextcloud'
  })
});

export const CLOUD_STORAGE_TYPES = Object.freeze(Object.keys(CLOUD_STORAGE_PROVIDERS));

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
 * The installation of one provider type: the singleton id, read only from an
 * installation of its own definition (another definition under that id does
 * not count, as with the other built-ins).
 * @param {string} type - `office365` | `googledrive` | `nextcloud`
 * @returns {object|null}
 */
export function getCloudStorageInstallation(type) {
  const spec = CLOUD_STORAGE_PROVIDERS[type];
  if (!spec) return null;
  return (
    installedList().find(
      instance => instance?.id === spec.instanceId && instance.definition === spec.definitionId
    ) || null
  );
}

/** The provider id (callback URLs, token files) of an installation: its `providerId` value, else its id. */
export function providerIdOf(instance) {
  return text(instance?.values?.providerId) || instance?.id || '';
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
  if (!type) return null;
  const spec = CLOUD_STORAGE_PROVIDERS[type];
  const values = instance.values || {};
  const id = providerIdOf(instance);
  const provider = {
    id,
    name: id,
    displayName: displayNameOf(instance, spec),
    type,
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
 * Every configured cloud storage provider, enabled or not, in the shape of
 * the former `platform.cloudStorage.providers`.
 * @returns {object[]}
 */
export function listCloudStorageProviders() {
  return CLOUD_STORAGE_TYPES.map(type => getCloudStorageInstallation(type))
    .filter(Boolean)
    .map(providerFromInstance)
    .filter(Boolean);
}

/**
 * The provider a request names, by its provider id (and type when known).
 * @param {string} providerId
 * @param {string} [type]
 * @returns {object|null}
 */
export function findCloudStorageProvider(providerId, type) {
  if (!providerId) return null;
  return (
    listCloudStorageProviders().find(
      provider => provider.id === providerId && (!type || provider.type === type)
    ) || null
  );
}

/**
 * The former `platform.cloudStorage` as `/api/auth/status` sends it to the
 * client (no secrets): enabled while one provider is, and the providers.
 * @returns {{ enabled: boolean, providers: Array<{ id: string, name: string, displayName: string, type: string, enabled: boolean }> }}
 */
export function cloudStorageStatus() {
  const providers = listCloudStorageProviders().map(p => ({
    id: p.id,
    name: p.name,
    displayName: p.displayName,
    type: p.type,
    enabled: p.enabled
  }));
  return { enabled: providers.some(p => p.enabled), providers };
}

/** Whether a provider type has an enabled installation with its OAuth client filled in. */
export function isCloudStorageProviderConfigured(type) {
  const provider = providerFromInstance(getCloudStorageInstallation(type));
  if (!provider || !provider.enabled || !provider.clientId || !provider.clientSecretRef) {
    return false;
  }
  if (type === 'office365') return Boolean(provider.tenantId);
  if (type === 'nextcloud') return Boolean(provider.serverUrl);
  return true;
}

/**
 * The users who connected a provider: one token file per user under
 * `<contents>/integrations/<service>/`, named `<userId>__<providerId>.json`
 * (or `<userId>.json` from before provider ids were part of the name).
 * @param {string} type
 * @param {string} [providerId] - defaults to the installation's provider id
 * @returns {Promise<Array<{ userId: string, createdAt: string|null, expiresAt: string|null, expired: boolean }>>}
 */
export async function listCloudStorageConnections(type, providerId) {
  const spec = CLOUD_STORAGE_PROVIDERS[type];
  if (!spec) return [];
  const wanted = providerId || providerIdOf(getCloudStorageInstallation(type));
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
    if (fileProviderId && wanted && fileProviderId !== wanted) continue;
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
