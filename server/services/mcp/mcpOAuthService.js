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
 *      (`clientId` + optional `clientSecretRef`); iHub's per-server Client ID
 *      Metadata Document, when the authorization server advertises
 *      `client_id_metadata_document_supported` and iHub's public base is https;
 *      dynamic client registration (RFC 7591). The result is stored per
 *      server (`mcpOAuthClientStore.js`) and reused for every user. It is
 *      only ever replaced from a trusted public base (the configured Public
 *      URL, or an admin's own sign-in), never because one request carried
 *      another Host header.
 *   3. Authorization request — authorization code + PKCE (S256), the RFC 8707
 *      `resource` indicator, the server's own redirect URI
 *      (`…/callback/<serverId>`), and a signed `state` ticket that carries the
 *      encrypted verifier and names the authorization server (issuer) and
 *      client the request went to (`mcpOAuthTicket.js`).
 *   4. Callback — the ticket is verified, bound to the signed-in user and to
 *      the callback's server; an RFC 9207 `iss` must name the ticket's
 *      issuer (and is required when the server advertises
 *      `authorization_response_iss_parameter_supported`); the code is
 *      exchanged only when the server's registration still is the ticket's
 *      authorization server and client; the tokens are stored encrypted per
 *      (user, server), bound to the server's endpoint and auth block.
 *   5. Refresh — {@link refreshUserTokens}, driven single-flight by the
 *      manager.
 *
 * Every HTTP request goes through `safeFetch` with the MCP servers' SSRF
 * policy, redirects refused. Tokens, codes and verifiers are never logged.
 *
 * @module services/mcp/mcpOAuthService
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
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
import {
  buildMcpOAuthFetch,
  McpAuthRequiredError,
  McpTokenRefreshError,
  McpUserOAuthProvider
} from './McpUserOAuthProvider.js';
import {
  readUserTokens,
  writeUserTokens,
  deleteUserTokens,
  tokenBindingFor
} from './mcpUserTokens.js';
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
  REGISTRATION_FAILED: 'registration_failed',
  ISSUER_MISMATCH: 'issuer_mismatch',
  PUBLIC_URL_MISMATCH: 'public_url_mismatch'
});

/**
 * OAuth error codes that mean the authorization server definitively refused
 * the refresh token or the client — the stored tokens are dead. Anything else
 * (network error, timeout, 5xx, `server_error`, an unparsable answer) is
 * transient and keeps them.
 */
const DEFINITIVE_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client'
]);
const DEFINITIVE_REFRESH_ERROR_NAMES = new Set([
  'InvalidGrantError',
  'InvalidClientError',
  'UnauthorizedClientError'
]);

/**
 * The OAuth error code of a definitive refusal, or null.
 * @param {unknown} error
 * @returns {string|null} `invalid_grant` | `invalid_client` | `unauthorized_client`
 */
export function definitiveOAuthRejection(error) {
  const code = typeof error?.errorCode === 'string' ? error.errorCode : null;
  if (code && DEFINITIVE_REFRESH_ERRORS.has(code)) return code;
  if (DEFINITIVE_REFRESH_ERROR_NAMES.has(error?.name)) {
    return error.name === 'InvalidGrantError'
      ? 'invalid_grant'
      : error.name === 'InvalidClientError'
        ? 'invalid_client'
        : 'unauthorized_client';
  }
  return null;
}

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

/** In-flight registrations per server id: concurrent first sign-ins share one. */
const pendingRegistrations = new Map();

/**
 * Resolve (and persist) iHub's client identity at the server's authorization
 * server: pre-registered → CIMD → DCR. An existing registration for the same
 * config, authorization server and redirect URI is reused. Concurrent calls
 * for one server share a single registration (single-flight per worker).
 *
 * An existing registration made for another public base is replaced only
 * when the base is trusted — the configured Public URL, or an admin's own
 * sign-in. A base derived from one request's Host header is not: replacing
 * the shared registration on its say-so would break every other user's
 * refresh. The sign-in is then refused with `public_url_mismatch` and the
 * server log tells the admin to set the Public URL.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig
 * @param {Object} params.discovery - Result of {@link discoverServer}
 * @param {string} params.publicBase
 * @param {boolean} [params.trustedBase=false] - May replace a registration made for another base
 * @param {Function} params.fetchFn
 * @param {McpOAuthClientStore} [params.clientStore]
 * @returns {Promise<{clientInformation: Object, registration: Object}>}
 * @throws {McpOAuthFlowError} `registration_failed` | `public_url_mismatch`
 */
export async function resolveClientRegistration(params) {
  const serverId = params.serverConfig.id;
  const inFlight = pendingRegistrations.get(serverId);
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      /* the other sign-in failed; this one tries for itself */
    }
  }
  const run = resolveClientRegistrationOnce(params);
  pendingRegistrations.set(serverId, run);
  try {
    return await run;
  } finally {
    if (pendingRegistrations.get(serverId) === run) pendingRegistrations.delete(serverId);
  }
}

async function resolveClientRegistrationOnce({
  serverConfig,
  discovery,
  publicBase,
  trustedBase = false,
  fetchFn,
  clientStore = getMcpOAuthClientStore()
}) {
  const serverId = serverConfig.id;
  const redirectUri = mcpCallbackUrl(publicBase, serverId);
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

  const existing = await clientStore.getFor(serverConfig);
  if (existing?.publicBase && existing.publicBase !== publicBase && !trustedBase) {
    logger.error(
      'MCP OAuth sign-in refused: the request reached iHub under another public URL than the one the server was registered for. Set the MCP gateway Public URL (platform.mcpServer.publicUrl).',
      { component: COMPONENT, serverId }
    );
    throw new McpOAuthFlowError(
      MCP_OAUTH_ERROR_CODES.PUBLIC_URL_MISMATCH,
      'Public base differs from the registered one'
    );
  }

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

  // 2. Client ID Metadata Document (one per server).
  if (metadata?.client_id_metadata_document_supported === true && isCimdCapableBase(publicBase)) {
    const clientMetadataUrl = mcpClientMetadataUrl(publicBase, serverId);
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
        serverId,
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
 * The issuer identifier RFC 9207 `iss` must carry for this discovery result:
 * the metadata's `issuer`, else the authorization server URL.
 * @param {Object} discovery
 * @returns {string}
 */
function expectedIssuer(discovery) {
  const issuer = discovery.authorizationServerMetadata?.issuer;
  return typeof issuer === 'string' && issuer ? issuer : String(discovery.authorizationServerUrl);
}

/**
 * Start a user's sign-in: discovery, client identity, PKCE, signed state.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig - `oauthUser` server
 * @param {Object} params.user - Signed-in user
 * @param {string} params.publicBase
 * @param {boolean} [params.trustedBase=false] - See {@link resolveClientRegistration}
 * @param {string} params.returnUrl - Validated return URL
 * @param {Object} [params.security] - MCP SSRF policy
 * @param {McpOAuthClientStore} [params.clientStore]
 * @returns {Promise<{authorizationUrl: URL}>}
 * @throws {McpOAuthFlowError}
 */
export async function startUserAuthorization({
  serverConfig,
  user,
  publicBase,
  trustedBase = false,
  returnUrl,
  security,
  clientStore = getMcpOAuthClientStore()
}) {
  const fetchFn = buildMcpOAuthFetch(security);
  const discovery = await discoverServer(serverConfig, fetchFn);
  const { clientInformation } = await resolveClientRegistration({
    serverConfig,
    discovery,
    publicBase,
    trustedBase,
    fetchFn,
    clientStore
  });

  const scopes = Array.isArray(serverConfig.auth?.scopes) ? serverConfig.auth.scopes : [];
  const scope = scopes.length
    ? scopes.join(' ')
    : discovery.resourceMetadata?.scopes_supported?.join(' ') || undefined;
  const resource = resourceIndicatorFor(serverConfig.transport.url, discovery.resourceMetadata);
  const redirectUri = mcpCallbackUrl(publicBase, serverConfig.id);

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
    issuer: expectedIssuer(discovery),
    authorizationServerUrl: String(discovery.authorizationServerUrl),
    clientId: clientInformation.client_id,
    issRequired:
      discovery.authorizationServerMetadata?.authorization_response_iss_parameter_supported ===
      true,
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
 * Finish a sign-in: check the authorization response came from the server
 * the request went to, exchange the code with the verifier from the (already
 * verified and user-bound) ticket, and store the tokens.
 *
 * Mix-up defence (RFC 9700 §4.4): an `iss` parameter (RFC 9207) must equal
 * the ticket's issuer, and a missing one is refused when the authorization
 * server promised to send it. The code is then exchanged only when the
 * server's current registration is still the ticket's authorization server
 * and client — never at whatever registration happens to be current.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig
 * @param {Object} params.ticket - Verified ticket (see mcpOAuthTicket.verifyMcpOAuthTicket)
 * @param {string} params.code - Authorization code
 * @param {string} [params.iss] - RFC 9207 `iss` of the authorization response
 * @param {Object} [params.security]
 * @param {McpOAuthClientStore} [params.clientStore]
 * @returns {Promise<void>}
 * @throws {McpOAuthFlowError} `issuer_mismatch` | `exchange_failed`
 */
export async function completeUserAuthorization({
  serverConfig,
  ticket,
  code,
  iss,
  security,
  clientStore = getMcpOAuthClientStore()
}) {
  if (typeof iss === 'string' && iss) {
    if (iss !== ticket.issuer) {
      throw new McpOAuthFlowError(
        MCP_OAUTH_ERROR_CODES.ISSUER_MISMATCH,
        'Authorization response names another issuer'
      );
    }
  } else if (iss !== undefined || ticket.issRequired) {
    throw new McpOAuthFlowError(
      MCP_OAUTH_ERROR_CODES.ISSUER_MISMATCH,
      'Authorization response without the required iss parameter'
    );
  }

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
  if (
    registration.authorizationServerUrl !== ticket.authorizationServerUrl ||
    clientInformation.client_id !== ticket.clientId
  ) {
    throw new McpOAuthFlowError(
      MCP_OAUTH_ERROR_CODES.EXCHANGE_FAILED,
      'The OAuth client registration changed since the sign-in started'
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
    // `invalid_client`: the registration is dead for everybody; the next
    // sign-in registers afresh.
    if (definitiveOAuthRejection(error) === 'invalid_client' && registration.source !== 'config') {
      await clientStore.clear(serverConfig.id);
    }
    throw new McpOAuthFlowError(MCP_OAUTH_ERROR_CODES.EXCHANGE_FAILED, error.message);
  }
  await writeUserTokens(
    ticket.userId,
    serverConfig.id,
    tokens,
    tokenBindingFor(serverConfig, {
      authorizationServerUrl: registration.authorizationServerUrl,
      clientId: clientInformation.client_id,
      resource: ticket.resource
    })
  );
  logger.info('MCP OAuth sign-in completed', {
    component: COMPONENT,
    serverId: serverConfig.id,
    userId: ticket.userId
  });
}

/**
 * One refresh of a user's tokens at the authorization server that issued
 * them. The caller (`McpClientManager._refreshUserTokens`) makes it
 * single-flight per (user, server) and decides what to delete.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig
 * @param {string} params.userId
 * @param {Object} params.current - The stored token payload (with `refresh_token`)
 * @param {Object} [params.security]
 * @param {McpOAuthClientStore} [params.clientStore]
 * @param {Function} [params.refresh] - Test seam; the SDK's `refreshAuthorization`
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
  refresh = refreshAuthorization
}) {
  const serverId = serverConfig.id;
  const registration = await clientStore.getFor(serverConfig);
  const provider = new McpUserOAuthProvider({ serverConfig, userId, clientStore });
  const clientInformation =
    provider.configuredClientInformation() || McpOAuthClientStore.clientInformationOf(registration);
  const authorizationServerUrl = registration?.authorizationServerUrl;
  if (!clientInformation || !authorizationServerUrl) {
    throw new McpAuthRequiredError(serverId, 'No OAuth client registration to refresh with');
  }
  const binding = current.binding || {};
  // A refresh token goes back only to the authorization server and client it
  // was issued to; one made for another is useless — and must not leak.
  if (
    (binding.authorizationServerUrl && binding.authorizationServerUrl !== authorizationServerUrl) ||
    (binding.clientId && binding.clientId !== clientInformation.client_id)
  ) {
    const error = new McpAuthRequiredError(serverId, 'Tokens were issued to another client');
    error.rejection = 'other_client';
    throw error;
  }

  let tokens;
  try {
    tokens = await refresh(authorizationServerUrl, {
      metadata: registration.discovery?.authorizationServerMetadata,
      clientInformation,
      refreshToken: current.refresh_token,
      ...(binding.resource ? { resource: new URL(binding.resource) } : {}),
      fetchFn: buildMcpOAuthFetch(security)
    });
  } catch (error) {
    const rejection = definitiveOAuthRejection(error);
    if (rejection) {
      const refused = new McpAuthRequiredError(serverId, `Refresh refused: ${rejection}`);
      refused.rejection = rejection;
      refused.source = registration.source;
      throw refused;
    }
    throw new McpTokenRefreshError(serverId, error?.message || String(error));
  }
  await writeUserTokens(userId, serverId, tokens, {
    ...tokenBindingFor(serverConfig, {
      authorizationServerUrl,
      clientId: clientInformation.client_id,
      resource: binding.resource
    })
  });
  logger.info('MCP user tokens refreshed', { component: COMPONENT, serverId, userId });
  return readUserTokens(userId, serverId);
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
