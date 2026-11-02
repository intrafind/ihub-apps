// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connectors of the storage providers `com.intrafind/office365`,
 * `com.intrafind/google-drive` and `com.intrafind/nextcloud` (any number of
 * installations each). They have no model-facing actions: an installation
 * holds one OAuth app, every user connects their own account
 * (`POST /api/integrations/<installation id>/connect`), and the
 * file browsers, the picker and the project cloud kinds read the providers
 * through `cloudStorageConfig.js`. The connectors supply the installation
 * test, the "n users connected" status and the Connections dialog, each per
 * installation.
 */
import credentialService from '../../../../../CredentialService.js';
import { httpFetch } from '../../../../../../utils/httpConfig.js';
import {
  CLOUD_STORAGE_PROVIDERS,
  cloudStorageCallbackPath,
  getCloudStorageInstallation,
  isCloudStorageProviderConfigured,
  listCloudStorageConnections,
  providerFromInstance,
  resolveCloudStorageRedirectUri
} from '../../../../cloudStorageConfig.js';

import { getIntegrationConnectionService } from '../../../../auth/IntegrationConnectionService.js';

const TEST_TIMEOUT_MS = 10000;
const CONNECTION_COUNT_REFRESH_MS = 30 * 1000;

/** Per installation id: the connected-users count shown in the installed list, re-counted at most every 30 s. */
const counts = new Map();

function countOf(instanceId) {
  return counts.get(instanceId)?.value ?? 0;
}

function setCount(instanceId, value) {
  counts.set(instanceId, {
    value: Math.max(0, Number(value) || 0),
    at: Date.now(),
    inFlight: null
  });
}

function refreshCount(type, instanceId, { force = false } = {}) {
  const entry = counts.get(instanceId) || { value: 0, at: -Infinity, inFlight: null };
  if (entry.inFlight) return entry.inFlight;
  if (!force && Date.now() - entry.at < CONNECTION_COUNT_REFRESH_MS) {
    return Promise.resolve(entry.value);
  }
  entry.inFlight = listCloudStorageConnections(type, instanceId)
    .then(
      list => {
        setCount(instanceId, list.length);
        return list.length;
      },
      () => entry.value
    )
    .finally(() => {
      const current = counts.get(instanceId);
      if (current) current.inFlight = null;
    });
  counts.set(instanceId, entry);
  return entry.inFlight;
}

/**
 * Re-count an installation's connections now (after a disconnect).
 * @param {string} type
 * @param {string} instanceId
 */
export function refreshCloudStorageConnectionCount(type, instanceId) {
  refreshCount(type, instanceId, { force: true }).catch(() => {});
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

/**
 * The OAuth client step: a client id and a client secret credential with a
 * value.
 *
 * @param {Object} provider - The provider (`providerFromInstance`)
 * @param {string} secret - The client secret's value; empty when it has none
 * @returns {{ id: string, label: string, status: string, message: string }}
 */
function clientStep(provider, secret) {
  return {
    id: 'client',
    label: 'OAuth client',
    status: provider.clientId && secret ? 'ok' : 'fail',
    message: clientStepMessage(provider, secret)
  };
}

/** What the OAuth client step reports: the first thing missing, or the client. */
function clientStepMessage(provider, secret) {
  if (!provider.clientId) return 'No client id';
  if (!provider.clientSecretRef) return 'No client secret credential';
  if (!secret) return `Credential "${provider.clientSecretRef}" has no value or does not exist`;
  return `Client ${provider.clientId.slice(0, 8)}… with secret`;
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
  return { ...step, status: 'ok', message: `${details}; installation "${provider.id}"` };
}

/**
 * The redirect URI step: a configured value must be an http(s) URL ending in
 * the installation's callback path; an empty one is derived from each request
 * (with the base path, like Jira), and the admin's own request shows what
 * that comes to.
 */
function redirectUriStep(provider, req) {
  const step = { id: 'redirect', label: 'Redirect URI' };
  const callbackPath = cloudStorageCallbackPath(provider.type, provider.id);
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
    derived = req ? resolveCloudStorageRedirectUri(req, { ...provider, redirectUri: '' }) : null;
  } catch {
    derived = null;
  }
  return {
    ...step,
    status: 'ok',
    message: derived
      ? `Empty: derived from the request, here ${derived}; register that URL with the provider`
      : `Empty: derived from each request as <scheme>://<host><base path>${callbackPath}; register that URL with the provider`
  };
}

/** The installation's id, or empty when the connector got none. */
function idOf(instance) {
  return typeof instance?.id === 'string' ? instance.id : '';
}

/**
 * The installation test: client id and secret present, the provider's own
 * settings, the redirect URI well-formed or derivable, the authorization
 * server reachable, and how many users are connected. The OAuth flow itself
 * needs a browser, so it is not run.
 */
async function test(type, { instance, values, user, req }) {
  // A draft from the install dialog may come without an id yet: the callback
  // path then shows the definition's proposed one.
  const provider = providerFromInstance({
    ...instance,
    id: idOf(instance) || type,
    definition: CLOUD_STORAGE_PROVIDERS[type].definitionId,
    values,
    enabled: true
  });
  const secret = provider.clientSecretRef
    ? credentialService.tryResolveSecret(provider.clientSecretRef)
    : '';
  const steps = [
    clientStep(provider, secret),
    settingsStep(provider),
    redirectUriStep(provider, req)
  ];
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
  setCount(provider.id, connections.length);
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
    /** For the installed list: per-user sign-in, how many users connected this installation. */
    status(instance) {
      const instanceId = idOf(instance);
      if (instanceId) refreshCount(type, instanceId).catch(() => {});
      return {
        connected: isCloudStorageProviderConfigured(providerFromInstance(instance)),
        perUser: true,
        userConnections: countOf(instanceId)
      };
    },
    /** The users connected to this installation, from the connection index. */
    async listConnections(instance) {
      const instanceId = idOf(instance);
      const connections = await getIntegrationConnectionService().listUserConnections(instanceId);
      setCount(instanceId, connections.filter(c => !c.expired).length);
      return connections;
    },
    /** Disconnect one user (revoked upstream when supported; audit `connection.revoke`). */
    async disconnectUser(instance, userId, { req } = {}) {
      const { removed } = await getIntegrationConnectionService().disconnect({
        installationId: idOf(instance),
        userId,
        req
      });
      return { removed: Boolean(removed) };
    },
    invalidate() {},
    onChanged() {}
  };
}

export const office365Connector = connectorFor('office365');
export const googleDriveConnector = connectorFor('googledrive');
export const nextcloudConnector = connectorFor('nextcloud');

/** A storage installation by id, for callers that have the connector only. */
export { getCloudStorageInstallation };
