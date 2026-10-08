/**
 * The MCP SDK `OAuthClientProvider` for one (user, server) pair.
 *
 * `StreamableHTTPClientTransport` / `SSEClientTransport` take an
 * `authProvider`: they send `Authorization: Bearer <tokens().access_token>`
 * and, on 401, run the SDK's `auth()` orchestrator.
 *
 * There is no user agent on the server, so this provider never redirects: it
 * throws {@link McpAuthRequiredError}, which the manager turns into a token
 * refresh or an "auth required" result carrying the Connect URL.
 *
 * **iHub owns the refresh.** `tokens()` hands the SDK the access token only,
 * never the refresh token, so the SDK never refreshes on its own. On a 401
 * the SDK ends in `redirectToAuthorization`, the manager catches the
 * auth-required error and refreshes once per (user, server) — single-flight,
 * re-reading the stored tokens first, deleting them only when the
 * authorization server definitively rejects them (`invalid_grant`,
 * `invalid_client`, `unauthorized_client`) and keeping them on network errors
 * and 5xx (see `McpClientManager._refreshUserTokens`). Parallel calls
 * therefore never race each other's refresh, and a refresh token is only ever
 * sent to the authorization server the tokens were issued by.
 *
 * Tokens are read from the encrypted per-user token files
 * (`mcpUserTokens.js`) and only when they were issued for this server's
 * current endpoint and auth block; the client registration and discovery
 * state come from the per-server registration store
 * (`mcpOAuthClientStore.js`). A pre-registered client in the server config
 * (`clientId` + `clientSecretRef`) takes precedence over a stored CIMD/DCR
 * registration.
 *
 * Every OAuth request iHub makes itself (discovery, registration, token,
 * revocation) uses {@link buildMcpOAuthFetch}: `safeFetch` bound to the MCP
 * servers' SSRF policy, with redirects refused, so an authorization server
 * cannot steer iHub to a private address with a 3xx.
 *
 * @module services/mcp/McpUserOAuthProvider
 */
import crypto from 'node:crypto';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import credentialService from '../CredentialService.js';
import { safeFetch } from './safeFetch.js';
import {
  getMcpOAuthClientStore,
  McpOAuthClientStore,
  registrationFingerprint
} from './mcpOAuthClientStore.js';
import {
  readUserTokens,
  readUserTokensFor,
  writeUserTokens,
  deleteUserTokens,
  tokenBindingFor
} from './mcpUserTokens.js';
import {
  buildMcpClientMetadata,
  isCimdCapableBase,
  mcpCallbackUrl,
  mcpClientMetadataUrl,
  PLACEHOLDER_PUBLIC_BASE
} from './mcpOAuthPublicUrl.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpUserOAuthProvider';

/** Error code of every "the user must connect first" condition. */
export const MCP_AUTH_REQUIRED = 'MCP_AUTH_REQUIRED';

/** Error code of a refresh that failed for a transient reason (tokens kept). */
export const MCP_AUTH_REFRESH_FAILED = 'MCP_AUTH_REFRESH_FAILED';

/** Error code of an OAuth request answered with a redirect (refused). */
export const MCP_OAUTH_REDIRECT_REFUSED = 'MCP_OAUTH_REDIRECT_REFUSED';

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
 * A token refresh that could not complete for a transient reason — network
 * error, timeout, 5xx, an unparsable answer. The stored tokens are kept; the
 * next call tries again.
 */
export class McpTokenRefreshError extends Error {
  /**
   * @param {string} serverId
   * @param {string} [message] - For the server log only
   */
  constructor(serverId, message = 'The MCP sign-in could not be renewed right now') {
    super(message);
    this.name = 'McpTokenRefreshError';
    this.code = MCP_AUTH_REFRESH_FAILED;
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
 * Whether an error is a transient refresh failure ({@link McpTokenRefreshError}).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTokenRefreshError(error) {
  return Boolean(error) && error?.code === MCP_AUTH_REFRESH_FAILED;
}

/**
 * Wrap a fetch so it never follows redirects: the request is sent with
 * `redirect: 'manual'` and a 3xx answer becomes an error. The SSRF guard
 * checks and pins only the first URL, so following a `Location` would let the
 * answering server steer iHub anywhere (an IP literal skips the pinned
 * lookup). OAuth discovery, registration, token and revocation endpoints must
 * answer directly.
 *
 * @param {(input: string|URL, init?: RequestInit) => Promise<Response>} fetchFn
 * @returns {(input: string|URL, init?: RequestInit) => Promise<Response>}
 */
export function withoutRedirects(fetchFn) {
  return async (input, init = {}) => {
    const response = await fetchFn(input, { ...init, redirect: 'manual' });
    const status = Number(response?.status);
    if ((status >= 300 && status < 400) || response?.type === 'opaqueredirect') {
      let origin = 'an OAuth endpoint';
      try {
        origin = new URL(typeof input === 'string' ? input : input?.href || input?.url).origin;
      } catch {
        /* keep the generic wording */
      }
      const error = new Error(
        `OAuth request to ${origin} answered with a redirect (${status}); redirects are not followed`
      );
      error.code = MCP_OAUTH_REDIRECT_REFUSED;
      throw error;
    }
    return response;
  };
}

/**
 * A `fetch` for the OAuth calls: `safeFetch` with the MCP servers' SSRF
 * policy (`security.allowedHosts`, `security.blockPrivateIps`), redirects
 * refused ({@link withoutRedirects}).
 *
 * @param {{allowedHosts?: string[], blockPrivateIps?: boolean}} [security]
 * @returns {(input: string|URL, init?: RequestInit) => Promise<Response>}
 */
export function buildMcpOAuthFetch(security = {}) {
  const policy = {
    allowHosts: security.allowedHosts || [],
    blockPrivateIps: security.blockPrivateIps !== false
  };
  return withoutRedirects((input, init = {}) => safeFetch(input, init, policy));
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
   * This server's redirect URI. The SDK reads it synchronously, and only to
   * decide that this is an interactive (authorization code) client, so it is
   * always defined — built from the base known at construction, or a
   * placeholder that never leaves iHub.
   */
  get redirectUrl() {
    return mcpCallbackUrl(this.publicBase || PLACEHOLDER_PUBLIC_BASE, this.serverId);
  }

  /** iHub's CIMD URL for this server, offered only when it would be a valid https client id. */
  get clientMetadataUrl() {
    return isCimdCapableBase(this.publicBase)
      ? mcpClientMetadataUrl(this.publicBase, this.serverId)
      : undefined;
  }

  /** Client metadata for dynamic registration (no `client_id`). */
  get clientMetadata() {
    const scopes = Array.isArray(this.serverConfig.auth?.scopes)
      ? this.serverConfig.auth.scopes
      : [];
    return {
      ...buildMcpClientMetadata({
        publicBase: this.publicBase || PLACEHOLDER_PUBLIC_BASE,
        serverId: this.serverId,
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

  /**
   * The stored access token, when it was issued for this server's current
   * endpoint and auth block. The refresh token is never handed to the SDK:
   * iHub refreshes itself, single-flight (see the module comment).
   */
  async tokens() {
    const payload = await readUserTokensFor(this.userId, this.serverConfig);
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
    if (typeof payload.id_token === 'string') tokens.id_token = payload.id_token;
    return tokens;
  }

  async saveTokens(tokens) {
    const current = await readUserTokens(this.userId, this.serverId);
    const binding = current?.binding || tokenBindingFor(this.serverConfig);
    await writeUserTokens(this.userId, this.serverId, tokens, binding);
    this._lastAccessToken = tokens?.access_token || null;
    logger.info('MCP user tokens stored', {
      component: COMPONENT,
      serverId: this.serverId,
      userId: this.userId
    });
  }

  /**
   * Never navigates: the server has no user agent. The thrown error surfaces
   * as "auth required", which the manager answers with a refresh or a
   * Connect button.
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
   * Delete the user's tokens — only the access token this provider handed
   * out. Tokens refreshed in the meantime (by another call or worker) are
   * kept, and nothing is deleted when this provider never handed out a token.
   * @returns {Promise<boolean>} True when tokens were deleted
   */
  async invalidateTokens() {
    if (!this._lastAccessToken) return false;
    const current = await readUserTokens(this.userId, this.serverId);
    if (!current) return false;
    if (current.access_token !== this._lastAccessToken) {
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
    // Only onto the registration made for this very config, and never
    // switching it to another authorization server: the registration's client
    // (and every user's refresh token) belongs to the one it was made at.
    const registration = await this.registration();
    if (!registration) return;
    if (
      registration.authorizationServerUrl &&
      state?.authorizationServerUrl &&
      String(state.authorizationServerUrl) !== registration.authorizationServerUrl
    ) {
      logger.warn('MCP server now names another authorization server; keeping the registered one', {
        component: COMPONENT,
        serverId: this.serverId
      });
      return;
    }
    await this.clientStore.update(this.serverId, {
      discovery: state,
      authorizationServerUrl: state?.authorizationServerUrl
    });
  }
}
