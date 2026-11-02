// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP discovery strategy of {@link module:services/integrations/auth/OAuthUserClient}
 * (MCP authorization spec, 2025-11-25), moved from `services/mcp/mcpOAuthService.js`:
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
 *      server (`mcpOAuthClientStore.js`, namespace `mcp-oauth-clients`) and
 *      reused for every user. It is only ever replaced from a trusted public
 *      base (the configured Public URL, or an admin's own sign-in), never
 *      because one request carried another Host header.
 *
 * Every HTTP request goes through `safeFetch` with the MCP servers' SSRF
 * policy, redirects refused (`buildMcpOAuthFetch`).
 *
 * @module services/integrations/auth/strategies/mcpDiscovery
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthServerInfo,
  registerClient
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import {
  getMcpOAuthClientStore,
  McpOAuthClientStore,
  registrationFingerprint
} from '../../../mcp/mcpOAuthClientStore.js';
import {
  buildMcpOAuthFetch,
  configuredMcpClientInformation
} from '../../../mcp/McpUserOAuthProvider.js';
import {
  buildMcpClientMetadata,
  isCimdCapableBase,
  mcpCallbackUrl,
  mcpClientMetadataUrl,
  mcpClientName
} from '../../../mcp/mcpOAuthPublicUrl.js';
import { OAUTH_FLOW_ERROR_CODES, OAuthFlowError } from '../OAuthUserClient.js';
import logger from '../../../../utils/logger.js';

const COMPONENT = 'McpDiscoveryStrategy';

/** Error code of a refresh/revocation with no client registration to use. */
export const NO_CLIENT_REGISTRATION = 'no_client_registration';

/**
 * RFC 9728 → RFC 8414 discovery for a server, honouring
 * `auth.authorizationServer`.
 *
 * @param {Object} serverConfig
 * @param {Function} fetchFn - SSRF-guarded fetch
 * @returns {Promise<{authorizationServerUrl: string, authorizationServerMetadata?: Object, resourceMetadata?: Object}>}
 * @throws {OAuthFlowError} `discovery_failed`
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
    throw new OAuthFlowError(OAUTH_FLOW_ERROR_CODES.DISCOVERY_FAILED, error.message);
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
 * The issuer identifier RFC 9207 `iss` must carry for this discovery result:
 * the metadata's `issuer`, else the authorization server URL.
 * @param {{authorizationServerUrl: string, authorizationServerMetadata?: Object}} discovery
 * @returns {string}
 */
export function expectedIssuer(discovery) {
  const issuer = discovery.authorizationServerMetadata?.issuer;
  return typeof issuer === 'string' && issuer ? issuer : String(discovery.authorizationServerUrl);
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
 * refresh. The sign-in is then refused with `public_url_mismatch`.
 *
 * @param {Object} params
 * @param {Object} params.serverConfig
 * @param {Object} params.discovery - Result of {@link discoverServer}
 * @param {string} params.publicBase
 * @param {boolean} [params.trustedBase=false]
 * @param {Function} params.fetchFn
 * @param {McpOAuthClientStore} [params.clientStore]
 * @returns {Promise<{clientInformation: Object, registration: Object}>}
 * @throws {OAuthFlowError} `registration_failed` | `public_url_mismatch`
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
    throw new OAuthFlowError(
      OAUTH_FLOW_ERROR_CODES.PUBLIC_URL_MISMATCH,
      'Public base differs from the registered one'
    );
  }

  // 1. Pre-registered client from the config. Its secret stays in the
  //    credential store; the record only remembers discovery and the base.
  const configured = configuredMcpClientInformation(serverConfig);
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
    throw new OAuthFlowError(OAUTH_FLOW_ERROR_CODES.REGISTRATION_FAILED, error.message);
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
 * The strategy for one `oauthUser` MCP server.
 *
 * - `authorize`: discovery and client identity (registers when needed); the
 *   context carries `ctx.publicBase` / `ctx.trustedBase`.
 * - `exchange` / `refresh` / `revoke`: the stored registration only — no
 *   discovery and no registration from a token call. Without one the
 *   strategy throws an error with `code` {@link NO_CLIENT_REGISTRATION}.
 *
 * @param {Object} options
 * @param {Object} options.serverConfig - Parsed server config (`auth.type === 'oauthUser'`)
 * @param {{allowedHosts?: string[], blockPrivateIps?: boolean}} [options.security]
 * @param {McpOAuthClientStore} [options.clientStore]
 * @returns {import('../OAuthUserClient.js').OAuthStrategy & {registration: Function}}
 */
export function createMcpDiscoveryStrategy({
  serverConfig,
  security,
  clientStore = getMcpOAuthClientStore()
}) {
  const fetchFn = buildMcpOAuthFetch(security);
  const configuredScopes = Array.isArray(serverConfig.auth?.scopes) ? serverConfig.auth.scopes : [];

  async function resolveForAuthorization(ctx) {
    const discovery = await discoverServer(serverConfig, fetchFn);
    const { clientInformation, registration } = await resolveClientRegistration({
      serverConfig,
      discovery,
      publicBase: ctx.publicBase,
      trustedBase: ctx.trustedBase === true,
      fetchFn,
      clientStore
    });
    const scopes = configuredScopes.length
      ? configuredScopes
      : discovery.resourceMetadata?.scopes_supported || [];
    return {
      issuer: expectedIssuer(discovery),
      authorizationServerUrl: String(discovery.authorizationServerUrl),
      metadata: discovery.authorizationServerMetadata || {
        authorization_endpoint: new URL('/authorize', discovery.authorizationServerUrl).href,
        token_endpoint: new URL('/token', discovery.authorizationServerUrl).href
      },
      clientInformation,
      scopes,
      resource: resourceIndicatorFor(serverConfig.transport.url, discovery.resourceMetadata).href,
      issRequired:
        discovery.authorizationServerMetadata?.authorization_response_iss_parameter_supported ===
        true,
      registrationSource: registration?.source,
      fetchFn
    };
  }

  async function resolveFromRegistration() {
    const registration = await clientStore.getFor(serverConfig);
    const clientInformation =
      configuredMcpClientInformation(serverConfig) ||
      McpOAuthClientStore.clientInformationOf(registration);
    if (!clientInformation || !registration?.authorizationServerUrl) {
      const error = new Error('No OAuth client registration for this server');
      error.code = NO_CLIENT_REGISTRATION;
      throw error;
    }
    const metadata = registration.discovery?.authorizationServerMetadata;
    return {
      issuer: expectedIssuer({
        authorizationServerUrl: registration.authorizationServerUrl,
        authorizationServerMetadata: metadata
      }),
      authorizationServerUrl: registration.authorizationServerUrl,
      metadata: metadata || {
        token_endpoint: new URL('/token', registration.authorizationServerUrl).href
      },
      clientInformation,
      scopes: configuredScopes,
      registrationSource: registration.source,
      publicBase: registration.publicBase || null,
      fetchFn
    };
  }

  return {
    id: 'mcp-discovery',
    serverConfig,
    async resolve(ctx = {}) {
      return ctx.purpose === 'authorize' ? resolveForAuthorization(ctx) : resolveFromRegistration();
    },
    /** The stored registration for this server's current config, or null. */
    registration() {
      return clientStore.getFor(serverConfig);
    }
  };
}
