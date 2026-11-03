// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP side of per-user OAuth (`auth.type: "oauthUser"`): who may connect
 * a server, the structured "connect first" tool result, and the refresh the
 * client manager drives single-flight per (user, server).
 *
 * The OAuth protocol itself is shared with every other integration:
 *
 *   - discovery (RFC 9728 → RFC 8414) and the client identity (pre-registered,
 *     CIMD, DCR) are the MCP discovery strategy
 *     (`integrations/auth/strategies/mcpDiscovery.js`);
 *   - the authorization request with PKCE, the code exchange, refresh and
 *     revocation are the shared client (`integrations/auth/OAuthUserClient.js`);
 *   - connect, the callback (`/api/mcp/oauth/callback/:serverId` is an alias of
 *     `/api/integrations/oauth/callback`), disconnect and the connection index
 *     are the connection service (`integrations/auth/IntegrationConnectionService.js`).
 *
 * Tokens stay where they always were (`mcpUserTokens.js`), bound to the
 * server's endpoint and auth block and to the issuer and client they came
 * from. Tokens, codes and verifiers are never logged.
 *
 * @module services/mcp/mcpOAuthService
 */
import configCache from '../../configCache.js';
import { enhanceUserWithPermissions } from '../../utils/authorization.js';
import { getLocalizedString } from '../../utils/localize.js';
import { isAdminUser, isAnonymousUser } from '../loop/runIdentity.js';
import { getBoundIntegrationIds, getVisibleToolIds, toolVisibleInSet } from './permissions.js';
import { getMcpOAuthClientStore } from './mcpOAuthClientStore.js';
import { McpAuthRequiredError, McpTokenRefreshError } from './McpUserOAuthProvider.js';
import { readUserTokens, writeUserTokens, tokenBindingFor } from './mcpUserTokens.js';
import { OAuthUserClient, definitiveOAuthRejection } from '../integrations/auth/OAuthUserClient.js';
import {
  NO_CLIENT_REGISTRATION,
  createMcpDiscoveryStrategy
} from '../integrations/auth/strategies/mcpDiscovery.js';
import {
  INTEGRATION_AUTH_REASONS,
  integrationAuthRequiredResult
} from '../integrations/auth/integrationAuthRequired.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpOAuth';

/**
 * Whether a parsed server config uses per-user OAuth.
 * @param {Object} serverConfig
 * @returns {boolean}
 */
export function isUserOAuthServer(serverConfig) {
  return serverConfig?.auth?.type === 'oauthUser';
}

/**
 * Display name of a server in the given language.
 * @param {Object} serverConfig
 * @param {string} [language='en']
 * @returns {string}
 */
export function serverDisplayName(serverConfig, language = 'en') {
  const name = getLocalizedString(serverConfig?.name, language || 'en', 'en', '');
  return name || serverConfig?.id || '';
}

/**
 * The user with group permissions resolved, as the app filters expect it.
 * @param {Object} user
 * @returns {Object}
 */
function withPermissions(user) {
  if (!user || user.permissions) return user;
  const platform = configCache.getPlatform() || {};
  return enhanceUserWithPermissions(user, platform.auth || {}, platform);
}

/**
 * Whether the installation behind a server admits the user: the user's
 * groups must grant it (`permissions.integrations`), on top of every grant
 * and binding, as for its tools (`filterIntegrationToolsForUser`). A server
 * without an installation is refused: the manager is fed from the
 * installations only.
 *
 * The installed-integration service is imported here, not at the top: it
 * reaches this module through the MCP adapter, and a static import would
 * close that cycle.
 */
async function installationAdmitsUser(instanceId, user) {
  const [{ default: installedIntegrationService }, { userMayUse }] = await Promise.all([
    import('../integrations/InstalledIntegrationService.js'),
    import('../integrations/integrationTools.js')
  ]);
  const instance = installedIntegrationService.get(instanceId);
  return Boolean(instance) && instance.enabled !== false && userMayUse(instance, user);
}

/**
 * Whether a user may connect (and use) an `oauthUser` server: admins always
 * (they configure and test it); anyone else when their groups grant the
 * installation (`permissions.integrations`) and an app they may open binds it
 * (`app.integrations`), or lists the server or one of its tools in `tools`,
 * or a group grants one of them. The tool checks reuse the MCP gateway's
 * visibility rule (`getVisibleToolIds` + `toolVisibleInSet`), which also
 * resolves "app lists the server id".
 *
 * @param {Object} user - Signed-in user (req.user)
 * @param {Object} serverConfig
 * @param {Object[]} [catalogTools] - The server's known iHub tool definitions
 * @returns {Promise<boolean>}
 */
export async function isServerVisibleToUser(user, serverConfig, catalogTools = []) {
  if (isAnonymousUser(user) || !serverConfig?.id) return false;
  const enhanced = withPermissions(user);
  if (isAdminUser(enhanced)) return true;
  if (!(await installationAdmitsUser(serverConfig.id, enhanced))) return false;
  const platform = configCache.getPlatform() || {};
  const bound = await getBoundIntegrationIds(enhanced, platform);
  if (bound.has(serverConfig.id)) return true;
  const visible = await getVisibleToolIds(enhanced, platform);
  if (toolVisibleInSet(serverConfig.id, visible, serverConfig.id)) return true;
  return (catalogTools || []).some(tool => toolVisibleInSet(tool.id, visible, serverConfig.id));
}

/**
 * The structured "connect first" tool result — returned, never thrown, so the
 * model can tell the user and the chat can render the one Connect card
 * (`INTEGRATION_AUTH_REQUIRED`, the same fields as every integration).
 *
 * @param {Object} serverConfig
 * @param {string} [language]
 * @param {Object} [options]
 * @param {string} [options.reason='not_connected'] - `not_connected` | `expired` | `insufficient_scope`
 * @param {string[]} [options.scopes] - Step-up: the scopes the re-authorization asks for
 * @returns {{error: string, integration: string, reason: string, message: string, connectUrl: string, scopes?: string[]}}
 */
export function buildAuthRequiredResult(
  serverConfig,
  language,
  { reason = INTEGRATION_AUTH_REASONS.NOT_CONNECTED, scopes } = {}
) {
  const serverName = serverDisplayName(serverConfig, language);
  const stepUp = Array.isArray(scopes) && scopes.length > 0;
  return integrationAuthRequiredResult({
    integration: serverConfig.id,
    reason: stepUp ? INTEGRATION_AUTH_REASONS.INSUFFICIENT_SCOPE : reason,
    message: stepUp
      ? `${serverName} needs more permissions for this tool. Ask the user to reconnect ${serverName} with the Connect card in the chat.`
      : `Connect ${serverName} to use this tool. Ask the user to connect ${serverName} with the Connect card in the chat.`,
    ...(stepUp ? { scopes } : {})
  });
}

/**
 * One refresh of a user's tokens at the authorization server that issued
 * them, through the shared OAuth client. The caller
 * (`McpClientManager._refreshUserTokens`) makes it single-flight per
 * (user, server) and decides what to delete.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig
 * @param {string} params.userId
 * @param {Object} params.current - The stored token payload (with `refresh_token`)
 * @param {Object} [params.security]
 * @param {import('./mcpOAuthClientStore.js').McpOAuthClientStore} [params.clientStore]
 * @param {Function} [params.refresh] - Test seam with the MCP SDK's `refreshAuthorization` signature
 * @returns {Promise<Object>} The new stored payload
 * @throws {McpAuthRequiredError} Definitively refused (`error.rejection` names why:
 *   `invalid_grant` | `invalid_client` | `unauthorized_client` | `other_client`), or
 *   no client to refresh with (no `rejection`: the tokens are not the problem)
 * @throws {McpTokenRefreshError} Transient failure — the tokens are still good
 */
export async function refreshUserTokens({
  serverConfig,
  userId,
  current,
  security,
  clientStore = getMcpOAuthClientStore(),
  refresh
}) {
  const serverId = serverConfig.id;
  const strategy = createMcpDiscoveryStrategy({ serverConfig, security, clientStore });
  const client = new OAuthUserClient({ strategy });
  const binding = current.binding || {};
  let context;
  try {
    context = await strategy.resolve({ purpose: 'refresh' });
  } catch (error) {
    if (error?.code === NO_CLIENT_REGISTRATION) {
      throw new McpAuthRequiredError(serverId, 'No OAuth client registration to refresh with');
    }
    throw new McpTokenRefreshError(serverId, error?.message || String(error));
  }
  let tokens;
  try {
    tokens = await client.refresh({
      refreshToken: current.refresh_token,
      binding,
      ...(refresh ? { refreshFn: refresh } : {})
    });
  } catch (error) {
    // A refresh token goes back only to the authorization server and client it
    // was issued to; one made for another is useless — and must not leak.
    const rejection =
      error?.errorCode === 'other_client' ? 'other_client' : definitiveOAuthRejection(error);
    if (rejection) {
      const refused = new McpAuthRequiredError(
        serverId,
        rejection === 'other_client'
          ? 'Tokens were issued to another client'
          : `Refresh refused: ${rejection}`
      );
      refused.rejection = rejection;
      refused.source = context.registrationSource;
      throw refused;
    }
    throw new McpTokenRefreshError(serverId, error?.message || String(error));
  }
  const raw = { ...tokens.raw, refresh_token: tokens.refreshToken };
  if (!raw.refresh_token) delete raw.refresh_token;
  await writeUserTokens(
    userId,
    serverId,
    raw,
    tokenBindingFor(serverConfig, {
      authorizationServerUrl: String(context.authorizationServerUrl),
      clientId: context.clientInformation.client_id,
      resource: binding.resource
    })
  );
  logger.info('MCP user tokens refreshed', { component: COMPONENT, serverId, userId });
  return readUserTokens(userId, serverId);
}
