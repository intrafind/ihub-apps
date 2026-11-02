// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the connection service needs to know about one installation: which
 * kind of connection it takes, where its secret lives, which OAuth strategy
 * signs a user in, and how the browser is sent back.
 *
 *   | Installation                                  | stack           | kind            |
 *   | --------------------------------------------- | --------------- | --------------- |
 *   | `jira` (com.intrafind/jira)                   | `jira`          | `oauth-user`    |
 *   | an Office 365 / Google Drive / Nextcloud one  | `cloud-storage` | `oauth-user`    |
 *   | an MCP server with `auth.type: oauthUser`     | `mcp`           | `oauth-user`    |
 *   | `ifinder` / `iassistant`                      | `sso`           | `sso`           |
 *   | any other with `auth.mode: service-account`   | `shared`        | `service-account` |
 *
 * The services stay the owners of their provider knowledge: each declares its
 * endpoints and scopes through `oauthStrategy(...)` and the shared client does
 * the rest. Services are imported lazily: they import the connection service
 * themselves, and a static import here would close that cycle.
 *
 * @module services/integrations/auth/connectionProviders
 */
import tokenStorage from '../../TokenStorageService.js';
import configCache from '../../../configCache.js';
import { buildServerPath } from '../../../utils/basePath.js';
import {
  JIRA_INSTANCE_ID,
  JIRA_TOKEN_SERVICE,
  getJiraInstallation,
  jiraConfigFromInstance,
  isJiraConfigured,
  resolveJiraRedirectUri
} from '../jiraConfig.js';
import {
  CLOUD_STORAGE_PROVIDERS,
  cloudStorageTypeOfDefinition,
  getCloudStorageInstallation,
  isCloudStorageProviderConfigured,
  mayUseCloudStorageProvider,
  providerFromInstance,
  resolveCloudStorageRedirectUri
} from '../cloudStorageConfig.js';
import { IASSISTANT_DEFINITION_ID, IFINDER_DEFINITION_ID } from '../ifinderConfig.js';
import { settingsFingerprint, tokenSecretRef, tokenStorageIdFor } from './tokenSecrets.js';

/** The issuer of Atlassian Cloud's OAuth 2.0 (3LO) authorization server. */
export const ATLASSIAN_ISSUER = 'https://auth.atlassian.com';

/** Where scheduled-run failures send the owner to reconnect (a client route). */
export const SETTINGS_INTEGRATIONS_PATH = '/settings/integrations';

/**
 * @typedef {Object} SecretView
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {string} [scope]
 * @property {Object} [binding] - What the tokens were issued for (issuer, client, fingerprint)
 */

/**
 * @typedef {Object} ConnectionDescriptor
 * @property {string} installationId
 * @property {'jira'|'cloud-storage'|'mcp'|'sso'|'shared'} stack
 * @property {'oauth-user'|'sso'|'service-account'} kind
 * @property {string} displayName
 * @property {boolean} enabled
 * @property {boolean} configured
 * @property {string|null} issuer
 * @property {string|null} fingerprint
 * @property {string} [service] - Token store service (oauth-user)
 * @property {string} [connectUrl] - Same-origin path that starts the sign-in
 * @property {string} [credentialRef] - Service account credential (shared)
 */

/**
 * Token store access for the stacks whose files hold the camelCase payload
 * (`{ accessToken, refreshToken, expiresIn, scope, providerId? }`): Jira and
 * the cloud storage providers.
 */
export function tokenStoreSecret({ service, providerId }) {
  return {
    ref(userId) {
      return tokenSecretRef({ service, storageId: tokenStorageIdFor(userId), providerId });
    },
    /** The file the user's tokens are read from (a legacy unscoped one counts). */
    async locate(userId) {
      const storageId = tokenStorageIdFor(userId);
      try {
        const meta = await tokenStorage.getTokenMetadata(storageId, service, providerId);
        return {
          secretRef: tokenSecretRef({
            service,
            storageId,
            providerId: meta.providerId || null
          }),
          createdAt: meta.createdAt || null,
          expiresAt: meta.expiresAt || null
        };
      } catch {
        return null;
      }
    },
    async read(userId) {
      try {
        return await tokenStorage.getUserTokens(tokenStorageIdFor(userId), service, providerId);
      } catch (error) {
        if (/not authenticated/i.test(error?.message || '')) return null;
        throw error;
      }
    },
    async write(userId, payload) {
      await tokenStorage.storeUserTokens(tokenStorageIdFor(userId), service, payload, providerId);
      return payload;
    },
    async remove(userId) {
      return tokenStorage.deleteUserTokens(tokenStorageIdFor(userId), service, providerId);
    },
    async expired(userId) {
      return tokenStorage.areTokensExpired(tokenStorageIdFor(userId), service, providerId);
    },
    /** @returns {SecretView|null} */
    view(stored) {
      if (!stored?.accessToken) return null;
      return {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        scope: stored.scope,
        binding: stored.binding
      };
    },
    /** The stored payload for freshly issued (or refreshed) tokens. */
    payloadFor(tokens, { previous, binding, extras = {} }) {
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || previous?.refreshToken,
        expiresIn: tokens.expiresIn,
        scope: tokens.scope ?? previous?.scope,
        ...(providerId ? { providerId } : {}),
        ...extras,
        ...(binding ? { binding } : {})
      };
    }
  };
}

function jiraDescriptor() {
  const instance = getJiraInstallation();
  if (!instance) return null;
  const cfg = jiraConfigFromInstance(instance);
  return {
    installationId: JIRA_INSTANCE_ID,
    stack: 'jira',
    kind: 'oauth-user',
    displayName: 'JIRA',
    enabled: cfg.enabled,
    configured: isJiraConfigured(cfg),
    issuer: ATLASSIAN_ISSUER,
    fingerprint: settingsFingerprint({ stack: 'jira', clientId: cfg.clientId }),
    service: JIRA_TOKEN_SERVICE,
    resultKey: 'jira',
    connectUrl: buildServerPath('/api/integrations/jira/auth'),
    secret: tokenStoreSecret({ service: JIRA_TOKEN_SERVICE, providerId: null }),
    async strategy() {
      const { default: JiraService } = await import('../JiraService.js');
      return JiraService.oauthStrategy();
    },
    redirectUri(req) {
      return resolveJiraRedirectUri(req, cfg);
    },
    // Jira has never checked group grants on connect; the tools gate usage.
    async mayConnect() {
      return true;
    },
    async onConnected({ wasConnected }) {
      if (wasConnected) return;
      const { adjustJiraConnectionCount } = await import('../jiraConnectionCount.js');
      adjustJiraConnectionCount(1);
    },
    async onDisconnected({ removed }) {
      if (!removed) return;
      const { adjustJiraConnectionCount } = await import('../jiraConnectionCount.js');
      adjustJiraConnectionCount(-1);
    }
  };
}

const CLOUD_SERVICE_MODULES = {
  office365: () => import('../Office365Service.js'),
  googledrive: () => import('../GoogleDriveService.js'),
  nextcloud: () => import('../NextcloudService.js')
};

/** What a cloud storage token was issued under: the endpoint and the client. */
function cloudFingerprint(provider) {
  const material = { stack: 'cloud-storage', type: provider.type, clientId: provider.clientId };
  if (provider.type === 'office365') material.tenantId = provider.tenantId;
  if (provider.type === 'nextcloud') {
    material.serverUrl = String(provider.serverUrl || '').replace(/\/+$/, '');
  }
  return settingsFingerprint(material);
}

function cloudIssuer(provider) {
  if (provider.type === 'office365') {
    return `https://login.microsoftonline.com/${provider.tenantId}/v2.0`;
  }
  if (provider.type === 'googledrive') return 'https://accounts.google.com';
  return String(provider.serverUrl || '').replace(/\/+$/, '') || null;
}

function cloudDescriptor(instance) {
  const provider = providerFromInstance(instance);
  if (!provider) return null;
  const spec = CLOUD_STORAGE_PROVIDERS[provider.type];
  const loadService = CLOUD_SERVICE_MODULES[provider.type];
  return {
    installationId: provider.id,
    stack: 'cloud-storage',
    kind: 'oauth-user',
    type: provider.type,
    displayName: { office365: 'Office 365', googledrive: 'Google Drive', nextcloud: 'Nextcloud' }[
      provider.type
    ],
    enabled: provider.enabled,
    configured: isCloudStorageProviderConfigured(provider),
    issuer: cloudIssuer(provider),
    fingerprint: cloudFingerprint(provider),
    service: spec.service,
    resultKey: provider.type,
    connectUrl: buildServerPath(
      `/api/integrations/${spec.service}/auth?providerId=${encodeURIComponent(provider.id)}`
    ),
    secret: tokenStoreSecret({ service: spec.service, providerId: provider.id }),
    async strategy() {
      const { default: service } = await loadService();
      return service.oauthStrategy(provider.id);
    },
    async storedExtras(tokens, previous) {
      const { default: service } = await loadService();
      return service.oauthStoredExtras ? service.oauthStoredExtras(tokens, previous) : {};
    },
    redirectUri(req) {
      return resolveCloudStorageRedirectUri(req, {
        id: provider.id,
        type: provider.type,
        redirectUri: provider.redirectUri
      });
    },
    async mayConnect(user) {
      return mayUseCloudStorageProvider(user, provider.id, provider.type);
    },
    async onDisconnected({ removed }) {
      if (!removed) return;
      const { refreshCloudStorageConnectionCount } =
        await import('../protocols/native/connectors/cloudStorage/index.js');
      refreshCloudStorageConnectionCount?.(provider.type, provider.id);
    }
  };
}

/** Token store access for per-user MCP tokens (snake_case payload with a binding). */
function mcpSecretStore(serverConfig, tokens) {
  const serverId = serverConfig.id;
  return {
    ref(userId) {
      return tokenSecretRef({
        service: tokens.MCP_TOKEN_SERVICE,
        storageId: tokenStorageIdFor(userId),
        providerId: serverId
      });
    },
    async locate(userId) {
      const storageId = tokenStorageIdFor(userId);
      try {
        const meta = await tokenStorage.getTokenMetadata(
          storageId,
          tokens.MCP_TOKEN_SERVICE,
          serverId
        );
        if (!meta.providerId) return null;
        return {
          secretRef: tokenSecretRef({
            service: tokens.MCP_TOKEN_SERVICE,
            storageId,
            providerId: serverId
          }),
          createdAt: meta.createdAt || null,
          expiresAt: meta.expiresAt || null
        };
      } catch {
        return null;
      }
    },
    /** Only tokens issued for this server's current endpoint and auth block. */
    read(userId) {
      return tokens.readUserTokensFor(userId, serverConfig);
    },
    async write(userId, payload) {
      const { binding, ...plain } = payload;
      await tokens.writeUserTokens(userId, serverId, plain, binding);
      return tokens.readUserTokens(userId, serverId);
    },
    remove(userId) {
      return tokens.deleteUserTokens(userId, serverId);
    },
    async expired(userId, stored) {
      return tokens.accessTokenExpired(stored);
    },
    view(stored) {
      if (!stored?.access_token) return null;
      return {
        accessToken: stored.access_token,
        refreshToken: stored.refresh_token,
        scope: stored.scope,
        binding: stored.binding
      };
    },
    payloadFor(issued, { previous, binding }) {
      return {
        ...issued.raw,
        access_token: issued.accessToken,
        token_type: issued.tokenType,
        ...(issued.refreshToken || previous?.refresh_token
          ? { refresh_token: issued.refreshToken || previous.refresh_token }
          : {}),
        ...(issued.expiresIn !== undefined ? { expires_in: issued.expiresIn } : {}),
        ...(issued.scope !== undefined ? { scope: issued.scope } : {}),
        binding
      };
    }
  };
}

async function mcpDescriptor(installationId) {
  const [{ default: mcpClientManager }, oauth, tokens, publicUrl, clientStore] = await Promise.all([
    import('../../mcp/McpClientManager.js'),
    import('../../mcp/mcpOAuthService.js'),
    import('../../mcp/mcpUserTokens.js'),
    import('../../mcp/mcpOAuthPublicUrl.js'),
    import('../../mcp/mcpOAuthClientStore.js')
  ]);
  const conn = mcpClientManager.getConnection(installationId);
  if (!conn || !oauth.isUserOAuthServer(conn.config)) return null;
  const serverConfig = conn.config;
  const registration = await mcpClientManager
    .clientRegistrations()
    .getFor(serverConfig)
    .catch(() => null);
  const { createMcpDiscoveryStrategy } = await import('./strategies/mcpDiscovery.js');
  return {
    installationId,
    stack: 'mcp',
    kind: 'oauth-user',
    displayName: oauth.serverDisplayName(serverConfig),
    enabled: serverConfig.enabled !== false,
    configured: true,
    issuer:
      registration?.discovery?.authorizationServerMetadata?.issuer ||
      registration?.authorizationServerUrl ||
      null,
    fingerprint: clientStore.registrationFingerprint(serverConfig),
    service: tokens.MCP_TOKEN_SERVICE,
    resultKey: 'mcp',
    connectUrl: publicUrl.mcpConnectPath(installationId),
    serverConfig,
    secret: mcpSecretStore(serverConfig, tokens),
    async strategy() {
      return createMcpDiscoveryStrategy({
        serverConfig,
        security: mcpClientManager.security,
        clientStore: mcpClientManager.clientRegistrations()
      });
    },
    redirectUri(_req, ctx = {}) {
      return publicUrl.mcpCallbackUrl(ctx.publicBase, installationId);
    },
    async mayConnect(user) {
      if (serverConfig.enabled === false) return false;
      return oauth.isServerVisibleToUser(
        user,
        serverConfig,
        await mcpClientManager.toolsOfServer(installationId)
      );
    },
    async onConnected({ userId, user }) {
      // The next call reconnects with the new token; listing the tools now
      // fills the server's shared catalog (best effort, not awaited).
      await mcpClientManager.evictUserConnection(installationId, userId);
      if (user) mcpClientManager.refreshCatalogForUser(installationId, user).catch(() => {});
    },
    async onDisconnected({ userId }) {
      await mcpClientManager.evictUserConnection(installationId, userId);
    }
  };
}

function installedList() {
  try {
    return configCache.getIntegrations?.()?.data?.installed || [];
  } catch {
    return [];
  }
}

/**
 * The descriptor of an installation, or null when it is not installed (or
 * takes no connection at all).
 *
 * @param {string} installationId
 * @returns {Promise<ConnectionDescriptor|null>}
 */
export async function describeInstallation(installationId) {
  if (typeof installationId !== 'string' || !installationId) return null;
  if (installationId === JIRA_INSTANCE_ID) {
    const jira = jiraDescriptor();
    if (jira) return jira;
  }
  const cloud = getCloudStorageInstallation(installationId);
  if (cloud && cloudStorageTypeOfDefinition(cloud.definition)) return cloudDescriptor(cloud);

  const instance = installedList().find(entry => entry?.id === installationId) || null;
  if (
    instance?.definition === IFINDER_DEFINITION_ID ||
    instance?.definition === IASSISTANT_DEFINITION_ID
  ) {
    // Per-request identity (JWT / token exchange from the user's own sign-in):
    // nothing stored, nothing to connect.
    return {
      installationId,
      stack: 'sso',
      kind: 'sso',
      displayName: installationId,
      enabled: instance.enabled !== false,
      configured: true,
      issuer: null,
      fingerprint: null
    };
  }

  const mcp = await mcpDescriptor(installationId).catch(() => null);
  if (mcp) return mcp;

  if (instance?.auth?.mode === 'service-account' && instance.auth.credentialRef) {
    return {
      installationId,
      stack: 'shared',
      kind: 'service-account',
      displayName: installationId,
      enabled: instance.enabled !== false,
      configured: true,
      issuer: null,
      fingerprint: settingsFingerprint({ credentialRef: instance.auth.credentialRef }),
      credentialRef: instance.auth.credentialRef
    };
  }
  return null;
}

/**
 * The descriptors of every installation that takes a per-user OAuth
 * connection (for the re-index and the admin views).
 *
 * @returns {Promise<ConnectionDescriptor[]>}
 */
export async function listUserOAuthDescriptors() {
  const out = [];
  for (const instance of installedList()) {
    const descriptor = await describeInstallation(instance?.id);
    if (descriptor?.kind === 'oauth-user') out.push(descriptor);
  }
  return out;
}
