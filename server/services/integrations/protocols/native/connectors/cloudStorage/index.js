// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connectors of the cloud storage installations `office365`
 * (`com.intrafind/office365`), `googledrive` (`com.intrafind/google-drive`)
 * and `nextcloud` (`com.intrafind/nextcloud`). They have no model-facing
 * actions: the installations hold each provider's OAuth app, every user
 * connects their own account (`/api/integrations/<type>/auth`), and the file
 * browsers, the picker and the project cloud kinds read the providers through
 * `cloudStorageConfig.js`. The connectors supply the installation test, the
 * "n users connected" status and the Connections dialog.
 */
import credentialService from '../../../../../CredentialService.js';
import { httpFetch } from '../../../../../../utils/httpConfig.js';
import {
  CLOUD_STORAGE_PROVIDERS,
  getCloudStorageInstallation,
  isCloudStorageProviderConfigured,
  listCloudStorageConnections,
  providerFromInstance,
  providerIdOf
} from '../../../../cloudStorageConfig.js';

const TEST_TIMEOUT_MS = 10000;
const CONNECTION_COUNT_REFRESH_MS = 30 * 1000;

/** Per type: the connected-users count shown in the installed list, re-counted at most every 30 s. */
const counts = new Map();

function countOf(type) {
  return counts.get(type)?.value ?? 0;
}

function setCount(type, value) {
  counts.set(type, { value: Math.max(0, Number(value) || 0), at: Date.now(), inFlight: null });
}

function refreshCount(type, { force = false } = {}) {
  const entry = counts.get(type) || { value: 0, at: -Infinity, inFlight: null };
  if (entry.inFlight) return entry.inFlight;
  if (!force && Date.now() - entry.at < CONNECTION_COUNT_REFRESH_MS) {
    return Promise.resolve(entry.value);
  }
  entry.inFlight = listCloudStorageConnections(type)
    .then(
      list => {
        setCount(type, list.length);
        return list.length;
      },
      () => entry.value
    )
    .finally(() => {
      const current = counts.get(type);
      if (current) current.inFlight = null;
    });
  counts.set(type, entry);
  return entry.inFlight;
}

/** Test seam: forget the counts. */
export function resetCloudStorageConnectionCounts() {
  counts.clear();
}

/** The URL the test reaches to see that the provider's authorization server answers. */
function probeUrl(provider) {
  switch (provider.type) {
    case 'office365':
      return `https://login.microsoftonline.com/${encodeURIComponent(provider.tenantId)}/v2.0/.well-known/openid-configuration`;
    case 'googledrive':
      return 'https://accounts.google.com/.well-known/openid-configuration';
    case 'nextcloud':
      return `${provider.serverUrl.replace(/\/+$/, '')}/status.php`;
    default:
      return null;
  }
}

/** The required settings of a provider type beyond the OAuth client. */
function settingsStep(provider) {
  const step = { id: 'settings', label: 'Provider settings' };
  if (provider.type === 'office365' && !provider.tenantId) {
    return { ...step, status: 'fail', message: 'No tenant id' };
  }
  if (provider.type === 'nextcloud' && !provider.serverUrl) {
    return { ...step, status: 'fail', message: 'No Nextcloud server URL' };
  }
  const details =
    provider.type === 'office365'
      ? `Tenant ${provider.tenantId}`
      : provider.type === 'nextcloud'
        ? provider.serverUrl
        : 'Google OAuth 2.0';
  return { ...step, status: 'ok', message: `${details}; provider id "${provider.id}"` };
}

/**
 * The redirect URI step: a configured value must be an http(s) URL ending in
 * the provider's callback path; an empty one is derived from each request,
 * and the admin's own request shows what that comes to.
 */
function redirectUriStep(provider, service, req) {
  const step = { id: 'redirect', label: 'Redirect URI' };
  const callbackPath = `/api/integrations/${service}/${provider.id}/callback`;
  if (provider.redirectUri) {
    let ok = false;
    try {
      const url = new URL(provider.redirectUri);
      ok = /^https?:$/.test(url.protocol) && url.pathname.endsWith(callbackPath);
    } catch {
      ok = false;
    }
    return {
      ...step,
      status: ok ? 'ok' : 'warn',
      message: ok
        ? provider.redirectUri
        : `${provider.redirectUri} should end in ${callbackPath} and be registered with the provider`
    };
  }
  let derived = null;
  try {
    derived = req ? serviceFor(provider.type)._buildCallbackUrl(req, provider.id) : null;
  } catch {
    derived = null;
  }
  return {
    ...step,
    status: 'ok',
    message: derived
      ? `Empty: derived from the request, here ${derived}; register that URL with the provider`
      : `Empty: derived from each request as <scheme>://<host>${callbackPath}; register that URL with the provider`
  };
}

let services = null;
/** The provider services, imported when first needed (they import the config cache and the token store). */
async function loadServices() {
  if (!services) {
    const [office365, googledrive, nextcloud] = await Promise.all([
      import('../../../../Office365Service.js'),
      import('../../../../GoogleDriveService.js'),
      import('../../../../NextcloudService.js')
    ]);
    services = {
      office365: office365.default,
      googledrive: googledrive.default,
      nextcloud: nextcloud.default
    };
  }
  return services;
}

function serviceFor(type) {
  if (!services) throw new Error('cloud storage services not loaded');
  return services[type];
}

/**
 * The installation test: client id and secret present, the provider's own
 * settings, the redirect URI well-formed or derivable, the authorization
 * server reachable, and how many users are connected. The OAuth flow itself
 * needs a browser, so it is not run.
 */
async function test(type, { instance, values, user, req }) {
  await loadServices();
  const provider = providerFromInstance({ ...instance, values, enabled: true });
  const spec = CLOUD_STORAGE_PROVIDERS[type];
  const steps = [];
  const secret = provider.clientSecretRef
    ? credentialService.tryResolveSecret(provider.clientSecretRef)
    : '';
  steps.push({
    id: 'client',
    label: 'OAuth client',
    status: provider.clientId && secret ? 'ok' : 'fail',
    message: !provider.clientId
      ? 'No client id'
      : !provider.clientSecretRef
        ? 'No client secret credential'
        : !secret
          ? `Credential "${provider.clientSecretRef}" has no value or does not exist`
          : `Client ${provider.clientId.slice(0, 8)}… with secret`
  });
  steps.push(settingsStep(provider));
  steps.push(redirectUriStep(provider, spec.service, req));
  const url = steps.some(step => step.status === 'fail') ? null : probeUrl(provider);
  if (url) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const response = await httpFetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal
      });
      steps.push({
        id: 'reachability',
        label: new URL(url).host,
        status: response.status < 500 ? 'ok' : 'warn',
        message: `HTTP ${response.status} in ${Date.now() - started} ms`
      });
    } catch (error) {
      steps.push({
        id: 'reachability',
        label: new URL(url).host,
        status: 'fail',
        message:
          error.name === 'AbortError' ? `No answer within ${TEST_TIMEOUT_MS} ms` : error.message,
        hints: [`Check the outbound proxy and firewall rules for ${new URL(url).host}`]
      });
    } finally {
      clearTimeout(timer);
    }
  }
  const connections = await listCloudStorageConnections(type, provider.id);
  setCount(type, connections.length);
  const mine = user?.id ? connections.some(c => c.userId === user.id) : false;
  steps.push({
    id: 'connections',
    label: 'Connected users',
    status: 'ok',
    message: `${connections.length} user(s) connected${user?.id ? (mine ? ', including you' : ', not you yet') : ''}`
  });
  return steps;
}

function connectorFor(type) {
  return {
    id: type,
    actions: {},
    test: context => test(type, context),
    /** For the installed list: per-user sign-in, how many users connected. */
    status(instance) {
      refreshCount(type).catch(() => {});
      return {
        connected: isCloudStorageProviderConfigured(type) && instance?.enabled !== false,
        perUser: true,
        userConnections: countOf(type)
      };
    },
    async listConnections(instance) {
      const connections = await listCloudStorageConnections(type, providerIdOf(instance));
      setCount(type, connections.length);
      return connections;
    },
    async disconnectUser(instance, userId) {
      await loadServices();
      const removed = await serviceFor(type).deleteUserTokens(userId, providerIdOf(instance));
      if (removed) refreshCount(type, { force: true }).catch(() => {});
      return { removed: Boolean(removed) };
    },
    invalidate() {},
    onChanged() {}
  };
}

export const office365Connector = connectorFor('office365');
export const googleDriveConnector = connectorFor('googledrive');
export const nextcloudConnector = connectorFor('nextcloud');

/** The installation of a type, for callers that have the connector only. */
export { getCloudStorageInstallation };
