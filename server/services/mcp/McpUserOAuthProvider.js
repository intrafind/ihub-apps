/**
 * The MCP SDK `OAuthClientProvider` for one (user, server) pair.
 *
 * `StreamableHTTPClientTransport` / `SSEClientTransport` take an
 * `authProvider`: they send `Authorization: Bearer <tokens().access_token>`,
 * and on 401 run the SDK's `auth()` orchestrator, which refreshes an expired
 * token (`refreshAuthorization`), drops tokens the authorization server calls
 * `invalid_grant` (`invalidateCredentials('tokens')`) and, when nothing else
 * helps, starts a new authorization and calls `redirectToAuthorization`.
 *
 * There is no user agent on the server, so this provider never redirects: it
 * throws {@link McpAuthRequiredError}, which the connection and the manager
 * turn into an "auth required" result carrying the Connect URL. The
 * interactive flow itself lives in `routes/mcpOAuth.js`; this class is the
 * token and registration accessor the transport (and those routes) share.
 *
 * Tokens are read from and written to the encrypted per-user token files
 * (`mcpUserTokens.js`), the client registration and discovery state from the
 * per-server registration store (`mcpOAuthClientStore.js`). A pre-registered
 * client in the server config (`clientId` + `clientSecretRef`) takes
 * precedence over a stored CIMD/DCR registration.
 *
 * Every HTTP request the SDK makes through this provider (discovery,
 * registration, token endpoint) uses {@link buildMcpOAuthFetch}: `safeFetch`
 * bound to the MCP servers' SSRF policy, so an authorization server cannot
 * steer iHub to a private address.
 *
 * @module services/mcp/McpUserOAuthProvider
 */
import crypto from 'crypto';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import credentialService from '../CredentialService.js';
import { safeFetch } from './safeFetch.js';
import {
  getMcpOAuthClientStore,
  McpOAuthClientStore,
  registrationFingerprint
} from './mcpOAuthClientStore.js';
import { readUserTokens, writeUserTokens, deleteUserTokens } from './mcpUserTokens.js';
import {
  buildMcpClientMetadata,
  isCimdCapableBase,
  mcpCallbackUrl,
  mcpClientMetadataUrl
} from './mcpOAuthPublicUrl.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpUserOAuthProvider';

/** Error code of every "the user must connect first" condition. */
export const MCP_AUTH_REQUIRED = 'MCP_AUTH_REQUIRED';

/**
 * Thrown instead of redirecting: the user has to complete the interactive
 * sign-in before this server can be used.
 */
export class McpAuthRequiredError extends Error {
  /**
   * @param {string} serverId
   * @param {string} [message]
   */
  constructor(serverId, message = 'Sign-in required for this MCP server') {
    super(message);
    this.name = 'McpAuthRequiredError';
    this.code = MCP_AUTH_REQUIRED;
    this.serverId = serverId;
  }
}

/**
 * Whether an error means "the user must (re)connect": our own marker, or the
 * SDK's `UnauthorizedError` from a transport that could not authenticate.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAuthRequiredError(error) {
  if (!error) return false;
  if (error instanceof McpAuthRequiredError || error?.code === MCP_AUTH_REQUIRED) return true;
  if (error instanceof UnauthorizedError) return true;
  return error?.name === 'UnauthorizedError';
}

/**
 * A `fetch` for the SDK's OAuth calls: `safeFetch` with the MCP servers'
 * SSRF policy (`security.allowedHosts`, `security.blockPrivateIps`).
 *
 * @param {{allowedHosts?: string[], blockPrivateIps?: boolean}} [security]
 * @returns {(input: string|URL, init?: RequestInit) => Promise<Response>}
 */
export function buildMcpOAuthFetch(security = {}) {
  const policy = {
    allowHosts: security.allowedHosts || [],
    blockPrivateIps: security.blockPrivateIps !== false
  };
  return (input, init = {}) => safeFetch(input, init, policy);
}

export class McpUserOAuthProvider {
  /**
   * @param {Object} options
   * @param {Object} options.serverConfig - Parsed `mcpServers.json` entry (`auth.type === 'oauthUser'`)
   * @param {string} options.userId - The real user id
   * @param {string|null} [options.publicBase] - Public base URL, when known (routes pass it)
   * @param {string} [options.clientName]
   * @param {McpOAuthClientStore} [options.clientStore]
   */
  constructor({ serverConfig, userId, publicBase = null, clientName, clientStore } = {}) {
    if (!serverConfig?.id) throw new Error('McpUserOAuthProvider needs a server config');
    if (typeof userId !== 'string' || !userId) {
      throw new Error('McpUserOAuthProvider needs a user id');
    }
    this.serverConfig = serverConfig;
    this.serverId = serverConfig.id;
    this.userId = userId;
    this.publicBase = publicBase;
    this.clientName = clientName;
    this.clientStore = clientStore || getMcpOAuthClientStore();
    /** Discovery state kept here when no registration exists to hold it. */
    this._discovery = null;
    this._codeVerifier = null;
    /** The access token last handed to the transport (guards token deletion). */
    this._lastAccessToken = null;
  }

  /** The stored registration for this server's current config, or null. */
  async registration() {
    return this.clientStore.getFor(this.serverConfig);
  }

  /**
   * The base the callback and CIMD URLs are built from: the one the stored
   * registration was made for, else the one this provider was given.
   * @returns {Promise<string|null>}
   */
  async resolvePublicBase() {
    const registration = await this.registration();
    return registration?.publicBase || this.publicBase || null;
  }

  // ── OAuthClientProvider ───────────────────────────────────────────────

  /**
   * The fixed redirect URI. The SDK reads this synchronously, so it is built
   * from the base known at construction; the routes always pass one, and a
   * pooled connection gets the base of its stored registration.
   */
  get redirectUrl() {
    return this.publicBase ? mcpCallbackUrl(this.publicBase) : undefined;
  }

  /** iHub's CIMD URL, offered only when it would be a valid https client id. */
  get clientMetadataUrl() {
    return isCimdCapableBase(this.publicBase) ? mcpClientMetadataUrl(this.publicBase) : undefined;
  }

  /** Client metadata for dynamic registration (no `client_id`). */
  get clientMetadata() {
    const scopes = Array.isArray(this.serverConfig.auth?.scopes)
      ? this.serverConfig.auth.scopes
      : [];
    return {
      ...buildMcpClientMetadata({
        publicBase: this.publicBase || 'https://ihub.invalid',
        clientName: this.clientName,
        withClientId: false
      }),
      ...(scopes.length ? { scope: scopes.join(' ') } : {})
    };
  }

  state() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Client identity, in precedence order: pre-registered client from the
   * config, then the stored CIMD/DCR registration. With neither, the transport
   * cannot authenticate and the user must run the interactive flow, which
   * registers the client — so this throws "auth required" rather than letting
   * the SDK register a client from a tool call.
   */
  async clientInformation() {
    const configured = this.configuredClientInformation();
    if (configured) return configured;
    const registration = await this.registration();
    const info = McpOAuthClientStore.clientInformationOf(registration);
    if (info) return info;
    throw new McpAuthRequiredError(this.serverId, 'MCP server has no OAuth client registration');
  }

  /**
   * The pre-registered client from the server config, or null.
   * @returns {{client_id: string, client_secret?: string}|null}
   */
  configuredClientInformation() {
    const auth = this.serverConfig.auth || {};
    if (typeof auth.clientId !== 'string' || !auth.clientId) return null;
    const info = { client_id: auth.clientId };
    if (auth.clientSecretRef) {
      const secret = credentialService.tryResolveSecret(auth.clientSecretRef);
      if (secret) info.client_secret = secret;
      else info.token_endpoint_auth_method = 'none';
    } else {
      info.token_endpoint_auth_method = 'none';
    }
    return info;
  }

  async saveClientInformation(info) {
    const registration = (await this.registration()) || {};
    await this.clientStore.put(this.serverId, {
      ...registration,
      source: registration.source || (info.client_id?.startsWith('https://') ? 'cimd' : 'dcr'),
      clientId: info.client_id,
      clientSecret: info.client_secret,
      clientIdIssuedAt: info.client_id_issued_at,
      tokenEndpointAuthMethod: info.token_endpoint_auth_method,
      authorizationServerUrl:
        registration.authorizationServerUrl || this._discovery?.authorizationServerUrl || '',
      discovery: registration.discovery || this._discovery || undefined,
      redirectUri: registration.redirectUri || this.redirectUrl || '',
      clientMetadataUrl: registration.clientMetadataUrl || this.clientMetadataUrl,
      publicBase: registration.publicBase || this.publicBase || '',
      fingerprint: registrationFingerprint(this.serverConfig)
    });
  }

  async tokens() {
    const payload = await readUserTokens(this.userId, this.serverId);
    if (!payload?.access_token) {
      this._lastAccessToken = null;
      return undefined;
    }
    this._lastAccessToken = payload.access_token;
    const tokens = {
      access_token: payload.access_token,
      token_type: payload.token_type || 'bearer'
    };
    if (Number.isFinite(payload.expires_in)) tokens.expires_in = payload.expires_in;
    if (typeof payload.scope === 'string') tokens.scope = payload.scope;
    if (typeof payload.refresh_token === 'string') tokens.refresh_token = payload.refresh_token;
    if (typeof payload.id_token === 'string') tokens.id_token = payload.id_token;
    return tokens;
  }

  async saveTokens(tokens) {
    await writeUserTokens(this.userId, this.serverId, tokens);
    this._lastAccessToken = tokens?.access_token || null;
    logger.info('MCP user tokens stored', {
      component: COMPONENT,
      serverId: this.serverId,
      userId: this.userId
    });
  }

  /**
   * Never navigates: the server has no user agent. The thrown error surfaces
   * as "auth required" so the user is shown a Connect button instead.
   */
  redirectToAuthorization() {
    throw new McpAuthRequiredError(this.serverId);
  }

  saveCodeVerifier(codeVerifier) {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier() {
    if (!this._codeVerifier) throw new McpAuthRequiredError(this.serverId, 'No PKCE verifier');
    return this._codeVerifier;
  }

  /**
   * @param {'all'|'client'|'tokens'|'verifier'|'discovery'} scope
   */
  async invalidateCredentials(scope) {
    if (scope === 'tokens' || scope === 'all') await this.invalidateTokens();
    if (scope === 'client' || scope === 'all') {
      // `invalid_client` from the authorization server: the registration is
      // dead for every user, so it is dropped and made afresh on the next
      // interactive sign-in.
      await this.clientStore.clear(this.serverId);
      logger.warn('MCP OAuth client registration invalidated', {
        component: COMPONENT,
        serverId: this.serverId
      });
    }
    if (scope === 'verifier' || scope === 'all') this._codeVerifier = null;
    if (scope === 'discovery' || scope === 'all') {
      this._discovery = null;
      await this.clientStore.update(this.serverId, { discovery: undefined });
    }
  }

  /**
   * Delete the user's tokens — unless another worker refreshed them in the
   * meantime (the file no longer holds the access token this provider handed
   * out), in which case the fresh tokens are kept.
   * @returns {Promise<boolean>} True when tokens were deleted
   */
  async invalidateTokens() {
    const current = await readUserTokens(this.userId, this.serverId);
    if (!current) return false;
    if (this._lastAccessToken && current.access_token !== this._lastAccessToken) {
      logger.info('MCP user tokens were refreshed elsewhere; keeping them', {
        component: COMPONENT,
        serverId: this.serverId,
        userId: this.userId
      });
      return false;
    }
    await deleteUserTokens(this.userId, this.serverId);
    this._lastAccessToken = null;
    logger.info('MCP user tokens invalidated', {
      component: COMPONENT,
      serverId: this.serverId,
      userId: this.userId
    });
    return true;
  }

  async discoveryState() {
    const registration = await this.registration();
    return registration?.discovery || this._discovery || undefined;
  }

  async saveDiscoveryState(state) {
    this._discovery = state;
    await this.clientStore.update(this.serverId, {
      discovery: state,
      authorizationServerUrl: state?.authorizationServerUrl
    });
  }
}
