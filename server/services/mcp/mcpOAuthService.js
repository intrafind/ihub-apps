/**
 * The interactive per-user OAuth flow for outbound MCP servers
 * (`auth.type: "oauthUser"`): discovery, client identity, the authorization
 * request, the code exchange and revocation. The routes in
 * `routes/mcpOAuth.js` are thin wrappers around these functions.
 *
 * Flow (MCP authorization spec, 2025-11-25):
 *
 *   1. Discovery — RFC 9728 protected-resource metadata on the MCP server
 *      names the authorization server; RFC 8414 / OIDC discovery on that
 *      server yields its endpoints. `auth.authorizationServer` overrides the
 *      first step. When the MCP server publishes no RFC 9728 document, its
 *      origin is taken as the authorization server (the SDK's legacy rule).
 *   2. Client identity, in this order: a pre-registered client from the config
 *      (`clientId` + optional `clientSecretRef`); iHub's Client ID Metadata
 *      Document, when the authorization server advertises
 *      `client_id_metadata_document_supported` and iHub's public base is https;
 *      dynamic client registration (RFC 7591). The result is stored per
 *      server (`mcpOAuthClientStore.js`) and reused for every user.
 *   3. Authorization request — authorization code + PKCE (S256), the RFC 8707
 *      `resource` indicator, the fixed redirect URI, and a signed `state`
 *      ticket that carries the encrypted verifier (`mcpOAuthTicket.js`).
 *   4. Callback — the ticket is verified and bound to the signed-in user, the
 *      code is exchanged with the verifier, the tokens are stored encrypted
 *      per (user, server).
 *
 * Every HTTP request goes through `safeFetch` with the MCP servers' SSRF
 * policy. Tokens, codes and verifiers are never logged.
 *
 * @module services/mcp/mcpOAuthService
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import configCache from '../../configCache.js';
import { enhanceUserWithPermissions } from '../../utils/authorization.js';
import { getLocalizedString } from '../../utils/localize.js';
import { isAdminUser, isAnonymousUser } from '../loop/runIdentity.js';
import { getVisibleToolIds, toolVisibleInSet } from './permissions.js';
import {
  getMcpOAuthClientStore,
  McpOAuthClientStore,
  registrationFingerprint
} from './mcpOAuthClientStore.js';
import { issueMcpOAuthTicket } from './mcpOAuthTicket.js';
import { buildMcpOAuthFetch, McpUserOAuthProvider } from './McpUserOAuthProvider.js';
import { readUserTokens, writeUserTokens, deleteUserTokens } from './mcpUserTokens.js';
import {
  buildMcpClientMetadata,
  isCimdCapableBase,
  mcpCallbackUrl,
  mcpClientMetadataUrl,
  mcpClientName,
  mcpConnectPath
} from './mcpOAuthPublicUrl.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpOAuth';

/**
 * Stable error codes the flow puts into the return URL (`?mcp_error=<code>`).
 * Text from the authorization server never reaches the URL.
 */
export const MCP_OAUTH_ERROR_CODES = Object.freeze({
  OAUTH_FAILED: 'oauth_failed',
  MISSING_CODE: 'missing_code',
  INVALID_STATE: 'invalid_state',
  STATE_EXPIRED: 'state_expired',
  USER_MISMATCH: 'user_mismatch',
  SERVER_NOT_FOUND: 'server_not_found',
  EXCHANGE_FAILED: 'exchange_failed',
  DISCOVERY_FAILED: 'discovery_failed',
  REGISTRATION_FAILED: 'registration_failed'
});

/** A flow failure with one of {@link MCP_OAUTH_ERROR_CODES}. */
export class McpOAuthFlowError extends Error {
  /**
   * @param {string} code - One of MCP_OAUTH_ERROR_CODES
   * @param {string} [message] - For the server log only
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'McpOAuthFlowError';
    this.code = code;
  }
}

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
 * Whether a user may connect (and use) an `oauthUser` server: admins always
 * (they configure and test it); anyone else when an app they may open lists
 * the server, or one of its tools, or when a group grants one of them. The
 * check reuses the MCP gateway's visibility rule (`getVisibleToolIds` +
 * `toolVisibleInSet`), which also resolves "app lists the server id".
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
  const platform = configCache.getPlatform() || {};
  const visible = await getVisibleToolIds(enhanced, platform);
  if (toolVisibleInSet(serverConfig.id, visible, serverConfig.id)) return true;
  return (catalogTools || []).some(tool => toolVisibleInSet(tool.id, visible, serverConfig.id));
}

/**
 * The structured "connect first" tool result — returned, never thrown, so the
 * model can tell the user and the chat can render a Connect card.
 *
 * @param {Object} serverConfig
 * @param {string} [language]
 * @returns {{error: string, message: string, authRequired: {serverId: string, serverName: string, connectUrl: string}}}
 */
export function buildAuthRequiredResult(serverConfig, language) {
  const serverName = serverDisplayName(serverConfig, language);
  const connectUrl = mcpConnectPath(serverConfig.id);
  return {
    error: 'MCP_AUTH_REQUIRED',
    message: `Connect ${serverName} to use this tool: ${connectUrl}`,
    authRequired: { serverId: serverConfig.id, serverName, connectUrl }
  };
}

/**
 * RFC 9728 → RFC 8414 discovery for a server, honouring
 * `auth.authorizationServer`.
 *
 * @param {Object} serverConfig
 * @param {Function} fetchFn - SSRF-guarded fetch
 * @returns {Promise<{authorizationServerUrl: string, authorizationServerMetadata?: Object, resourceMetadata?: Object}>}
 * @throws {McpOAuthFlowError} `discovery_failed`
 */
export async function discoverServer(serverConfig, fetchFn) {
  const serverUrl = serverConfig.transport.url;
  try {
    const override = serverConfig.auth?.authorizationServer;
    if (override) {
      let resourceMetadata;
      try {
        resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, {}, fetchFn);
      } catch {
        resourceMetadata = undefined;
      }
      const authorizationServerMetadata = await discoverAuthorizationServerMetadata(override, {
        fetchFn
      });
      return { authorizationServerUrl: override, authorizationServerMetadata, resourceMetadata };
    }
    return await discoverOAuthServerInfo(serverUrl, { fetchFn });
  } catch (error) {
    throw new McpOAuthFlowError(MCP_OAUTH_ERROR_CODES.DISCOVERY_FAILED, error.message);
  }
}

/**
 * The RFC 8707 resource indicator: the protected resource the server's own
 * metadata names when it matches the server URL, else the server URL
 * without its fragment.
 *
 * @param {string} serverUrl
 * @param {Object} [resourceMetadata]
 * @returns {URL}
 */
export function resourceIndicatorFor(serverUrl, resourceMetadata) {
  const fallback = resourceUrlFromServerUrl(serverUrl);
  const advertised = resourceMetadata?.resource;
  if (typeof advertised === 'string' && advertised) {
    try {
      if (checkResourceAllowed({ requestedResource: fallback, configuredResource: advertised })) {
        return new URL(advertised);
      }
    } catch {
      /* malformed metadata — fall back to the server URL */
    }
  }
  return fallback;
}

/**
 * Resolve (and persist) iHub's client identity at the server's authorization
 * server: pre-registered → CIMD → DCR. An existing registration for the same
 * config, authorization server and redirect URI is reused.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig
 * @param {Object} params.discovery - Result of {@link discoverServer}
 * @param {string} params.publicBase
 * @param {Function} params.fetchFn
 * @param {McpOAuthClientStore} [params.clientStore]
 * @returns {Promise<{clientInformation: Object, registration: Object}>}
 * @throws {McpOAuthFlowError} `registration_failed`
 */
export async function resolveClientRegistration({
  serverConfig,
  discovery,
  publicBase,
  fetchFn,
  clientStore = getMcpOAuthClientStore()
}) {
  const serverId = serverConfig.id;
  const redirectUri = mcpCallbackUrl(publicBase);
  const metadata = discovery.authorizationServerMetadata;
  const base = {
    authorizationServerUrl: discovery.authorizationServerUrl,
    discovery: {
      authorizationServerUrl: discovery.authorizationServerUrl,
      ...(metadata ? { authorizationServerMetadata: metadata } : {}),
      ...(discovery.resourceMetadata ? { resourceMetadata: discovery.resourceMetadata } : {})
    },
    redirectUri,
    publicBase,
    fingerprint: registrationFingerprint(serverConfig)
  };

  // 1. Pre-registered client from the config. Its secret stays in the
  //    credential store; the record only remembers discovery and the base.
  const provider = new McpUserOAuthProvider({ serverConfig, userId: 'registration', publicBase });
  const configured = provider.configuredClientInformation();
  if (configured) {
    const registration = await clientStore.put(serverId, {
      ...base,
      source: 'config',
      clientId: configured.client_id
    });
    return { clientInformation: configured, registration };
  }

  // Reuse a registration made for this authorization server and redirect URI.
  const existing = await clientStore.getFor(serverConfig);
  if (
    existing?.clientId &&
    existing.source !== 'config' &&
    existing.authorizationServerUrl === discovery.authorizationServerUrl &&
    existing.redirectUri === redirectUri
  ) {
    const registration = await clientStore.put(serverId, { ...existing, ...base });
    return {
      clientInformation: McpOAuthClientStore.clientInformationOf(registration),
      registration
    };
  }

  // 2. Client ID Metadata Document.
  if (metadata?.client_id_metadata_document_supported === true && isCimdCapableBase(publicBase)) {
    const clientMetadataUrl = mcpClientMetadataUrl(publicBase);
    const registration = await clientStore.put(serverId, {
      ...base,
      source: 'cimd',
      clientId: clientMetadataUrl,
      clientMetadataUrl,
      tokenEndpointAuthMethod: 'none'
    });
    return { clientInformation: { client_id: clientMetadataUrl }, registration };
  }

  // 3. Dynamic client registration (RFC 7591).
  const scopes = Array.isArray(serverConfig.auth?.scopes) ? serverConfig.auth.scopes : [];
  let full;
  try {
    full = await registerClient(discovery.authorizationServerUrl, {
      metadata,
      clientMetadata: buildMcpClientMetadata({
        publicBase,
        clientName: mcpClientName(),
        withClientId: false
      }),
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
      fetchFn
    });
  } catch (error) {
    throw new McpOAuthFlowError(MCP_OAUTH_ERROR_CODES.REGISTRATION_FAILED, error.message);
  }
  const registration = await clientStore.put(serverId, {
    ...base,
    source: 'dcr',
    clientId: full.client_id,
    clientSecret: full.client_secret,
    clientIdIssuedAt: full.client_id_issued_at,
    tokenEndpointAuthMethod: full.token_endpoint_auth_method
  });
  logger.info('Registered iHub as OAuth client of an MCP server', {
    component: COMPONENT,
    serverId,
    source: 'dcr'
  });
  return { clientInformation: McpOAuthClientStore.clientInformationOf(registration), registration };
}

/**
 * Start a user's sign-in: discovery, client identity, PKCE, signed state.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig - `oauthUser` server
 * @param {Object} params.user - Signed-in user
 * @param {string} params.publicBase
 * @param {string} params.returnUrl - Validated return URL
 * @param {Object} [params.security] - MCP SSRF policy
 * @returns {Promise<{authorizationUrl: URL}>}
 * @throws {McpOAuthFlowError}
 */
export async function startUserAuthorization({
  serverConfig,
  user,
  publicBase,
  returnUrl,
  security
}) {
  const fetchFn = buildMcpOAuthFetch(security);
  const discovery = await discoverServer(serverConfig, fetchFn);
  const { clientInformation } = await resolveClientRegistration({
    serverConfig,
    discovery,
    publicBase,
    fetchFn
  });

  const scopes = Array.isArray(serverConfig.auth?.scopes) ? serverConfig.auth.scopes : [];
  const scope = scopes.length
    ? scopes.join(' ')
    : discovery.resourceMetadata?.scopes_supported?.join(' ') || undefined;
  const resource = resourceIndicatorFor(serverConfig.transport.url, discovery.resourceMetadata);
  const redirectUri = mcpCallbackUrl(publicBase);

  let started;
  try {
    started = await startAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation,
      redirectUrl: redirectUri,
      scope,
      resource
    });
  } catch (error) {
    throw new McpOAuthFlowError(MCP_OAUTH_ERROR_CODES.DISCOVERY_FAILED, error.message);
  }

  // The verifier exists only now, so the state ticket that carries it is set
  // after the URL was built.
  const state = issueMcpOAuthTicket({
    serverId: serverConfig.id,
    userId: String(user.id),
    returnUrl,
    codeVerifier: started.codeVerifier,
    redirectUri,
    resource: resource.href
  });
  const authorizationUrl = new URL(started.authorizationUrl.href);
  authorizationUrl.searchParams.set('state', state);
  logger.info('MCP OAuth sign-in started', {
    component: COMPONENT,
    serverId: serverConfig.id,
    userId: user.id
  });
  return { authorizationUrl };
}

/**
 * Finish a sign-in: exchange the code with the verifier from the (already
 * verified and user-bound) ticket, and store the tokens.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig
 * @param {Object} params.ticket - Verified ticket (see mcpOAuthTicket.verifyMcpOAuthTicket)
 * @param {string} params.code - Authorization code
 * @param {Object} [params.security]
 * @param {McpOAuthClientStore} [params.clientStore]
 * @returns {Promise<void>}
 * @throws {McpOAuthFlowError} `exchange_failed`
 */
export async function completeUserAuthorization({
  serverConfig,
  ticket,
  code,
  security,
  clientStore = getMcpOAuthClientStore()
}) {
  const fetchFn = buildMcpOAuthFetch(security);
  const registration = await clientStore.getFor(serverConfig);
  const provider = new McpUserOAuthProvider({
    serverConfig,
    userId: ticket.userId,
    publicBase: registration?.publicBase || null,
    clientStore
  });
  const clientInformation =
    provider.configuredClientInformation() || McpOAuthClientStore.clientInformationOf(registration);
  if (!clientInformation || !registration?.authorizationServerUrl) {
    throw new McpOAuthFlowError(
      MCP_OAUTH_ERROR_CODES.EXCHANGE_FAILED,
      'No OAuth client registration for this server'
    );
  }

  let tokens;
  try {
    tokens = await exchangeAuthorization(registration.authorizationServerUrl, {
      metadata: registration.discovery?.authorizationServerMetadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier: ticket.codeVerifier,
      redirectUri: ticket.redirectUri,
      ...(ticket.resource ? { resource: new URL(ticket.resource) } : {}),
      fetchFn
    });
  } catch (error) {
    // `invalid_client`: the registration is dead for everybody.
    if (error?.name === 'InvalidClientError' || error?.errorCode === 'invalid_client') {
      await clientStore.clear(serverConfig.id);
    }
    throw new McpOAuthFlowError(MCP_OAUTH_ERROR_CODES.EXCHANGE_FAILED, error.message);
  }
  await writeUserTokens(ticket.userId, serverConfig.id, tokens);
  logger.info('MCP OAuth sign-in completed', {
    component: COMPONENT,
    serverId: serverConfig.id,
    userId: ticket.userId
  });
}

/**
 * Disconnect a user from a server: revoke the tokens at the authorization
 * server's `revocation_endpoint` when one was discovered (RFC 7009, best
 * effort), then delete them locally.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig
 * @param {string} params.userId
 * @param {Object} [params.security]
 * @param {McpOAuthClientStore} [params.clientStore]
 * @returns {Promise<{removed: boolean, revoked: boolean}>}
 */
export async function revokeUserConnection({
  serverConfig,
  userId,
  security,
  clientStore = getMcpOAuthClientStore()
}) {
  const tokens = await readUserTokens(userId, serverConfig.id);
  let revoked = false;
  if (tokens) {
    const registration = await clientStore.getFor(serverConfig);
    const endpoint = registration?.discovery?.authorizationServerMetadata?.revocation_endpoint;
    if (endpoint) {
      revoked = await revokeAtAuthorizationServer({
        endpoint,
        tokens,
        serverConfig,
        registration,
        fetchFn: buildMcpOAuthFetch(security)
      });
    }
  }
  const removed = await deleteUserTokens(userId, serverConfig.id);
  logger.info('MCP OAuth connection removed', {
    component: COMPONENT,
    serverId: serverConfig.id,
    userId,
    revoked
  });
  return { removed, revoked };
}

/**
 * POST each token to the revocation endpoint. Failures are logged, never thrown.
 * @returns {Promise<boolean>} True when every revocation was accepted
 */
async function revokeAtAuthorizationServer({
  endpoint,
  tokens,
  serverConfig,
  registration,
  fetchFn
}) {
  const provider = new McpUserOAuthProvider({
    serverConfig,
    userId: 'revocation',
    publicBase: registration?.publicBase || null
  });
  let clientInformation;
  try {
    clientInformation =
      provider.configuredClientInformation() ||
      McpOAuthClientStore.clientInformationOf(registration);
  } catch {
    clientInformation = null;
  }
  const candidates = [
    tokens.refresh_token ? ['refresh_token', tokens.refresh_token] : null,
    tokens.access_token ? ['access_token', tokens.access_token] : null
  ].filter(Boolean);
  let allOk = candidates.length > 0;
  for (const [hint, token] of candidates) {
    const body = new URLSearchParams({ token, token_type_hint: hint });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (clientInformation?.client_id) {
      if (clientInformation.client_secret) {
        const basic = Buffer.from(
          `${encodeURIComponent(clientInformation.client_id)}:${encodeURIComponent(clientInformation.client_secret)}`
        ).toString('base64');
        headers.Authorization = `Basic ${basic}`;
      } else {
        body.set('client_id', clientInformation.client_id);
      }
    }
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: body.toString()
      });
      if (!response.ok) allOk = false;
    } catch (error) {
      allOk = false;
      logger.warn('MCP OAuth token revocation failed', {
        component: COMPONENT,
        serverId: serverConfig.id,
        tokenType: hint,
        error: error.message
      });
    }
  }
  return allOk;
}
