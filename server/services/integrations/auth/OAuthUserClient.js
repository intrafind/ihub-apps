// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one per-user OAuth 2.x client of the integrations: authorization code
 * with PKCE (S256), code exchange, refresh, revocation (RFC 7009), the RFC 9207
 * `iss` check and scope step-up. Generalized from the MCP `oauthUser` client
 * (formerly `services/mcp/mcpOAuthService.js`), which was the most complete of
 * the four per-user stacks iHub had (Jira, cloud storage, MCP, iFinder).
 *
 * The client is stateless and protocol-only. *Where* an authorization server
 * is and *who* iHub is there comes from a **strategy**:
 *
 *   - `strategies/fixedEndpoint.js` — fixed authorization and token endpoints
 *     configured or known up front (Jira, Office 365, Google Drive, Nextcloud,
 *     and later OpenAPI and native connectors);
 *   - `strategies/mcpDiscovery.js` — RFC 9728 protected-resource metadata →
 *     RFC 8414 / OIDC discovery, then a pre-registered client, iHub's Client
 *     ID Metadata Document (CIMD) or dynamic client registration (RFC 7591).
 *
 * A strategy resolves to an {@link OAuthServerContext}. Credentials are keyed
 * by issuer: every token is bound to the issuer and client it came from (see
 * `IntegrationConnectionService`), and a refresh token is only ever sent back
 * to that issuer — never to whatever the configuration names today.
 *
 * Every request goes through the strategy's `fetchFn`: `httpFetch` (proxy and
 * the SSL whitelist of `platform.json`) for the fixed endpoints, `safeFetch`
 * with the MCP SSRF policy and redirects refused for discovered ones. Tokens,
 * codes and verifiers are never logged.
 *
 * @module services/integrations/auth/OAuthUserClient
 */
import crypto from 'node:crypto';
import logger from '../../../utils/logger.js';

const COMPONENT = 'OAuthUserClient';

/**
 * Stable error codes a sign-in puts into the return URL. Text from an
 * authorization server never reaches the URL.
 */
export const OAUTH_FLOW_ERROR_CODES = Object.freeze({
  OAUTH_FAILED: 'oauth_failed',
  ACCESS_DENIED: 'access_denied',
  MISSING_CODE: 'missing_code',
  INVALID_STATE: 'invalid_state',
  STATE_EXPIRED: 'state_expired',
  USER_MISMATCH: 'user_mismatch',
  INTEGRATION_NOT_FOUND: 'integration_not_found',
  EXCHANGE_FAILED: 'exchange_failed',
  DISCOVERY_FAILED: 'discovery_failed',
  REGISTRATION_FAILED: 'registration_failed',
  ISSUER_MISMATCH: 'issuer_mismatch',
  PUBLIC_URL_MISMATCH: 'public_url_mismatch',
  INVALID_CLIENT: 'invalid_client',
  CALLBACK_FAILED: 'callback_failed'
});

/** A flow failure carrying one of {@link OAUTH_FLOW_ERROR_CODES}. */
export class OAuthFlowError extends Error {
  /**
   * @param {string} code - One of OAUTH_FLOW_ERROR_CODES
   * @param {string} [message] - For the server log only
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'OAuthFlowError';
    this.code = code;
  }
}

/** A failed request to a token or revocation endpoint. */
export class OAuthTokenError extends Error {
  /**
   * @param {string} message - For the server log only (never contains a token)
   * @param {Object} [details]
   * @param {string} [details.errorCode] - The OAuth `error` the server answered with
   * @param {number} [details.status] - HTTP status
   * @param {string} [details.errorDescription] - The server's `error_description`, for
   *   classification only (never put into a URL or a user-facing message)
   */
  constructor(message, { errorCode, status, errorDescription } = {}) {
    super(message);
    this.name = 'OAuthTokenError';
    if (errorCode) this.errorCode = errorCode;
    if (status) this.status = status;
    if (errorDescription) this.errorDescription = errorDescription;
  }
}

/**
 * OAuth error codes that mean the authorization server definitively refused
 * the refresh token or the client. Anything else (network error, timeout, 5xx,
 * 429, `server_error`, an unparsable answer) is transient.
 */
const DEFINITIVE_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
const DEFINITIVE_ERROR_NAMES = new Map([
  ['InvalidGrantError', 'invalid_grant'],
  ['InvalidClientError', 'invalid_client'],
  ['UnauthorizedClientError', 'unauthorized_client']
]);

/**
 * The OAuth error code of a definitive refusal, or null for a transient one.
 * Understands {@link OAuthTokenError} and the MCP SDK's typed OAuth errors.
 *
 * @param {unknown} error
 * @returns {'invalid_grant'|'invalid_client'|'unauthorized_client'|null}
 */
export function definitiveOAuthRejection(error) {
  const code = typeof error?.errorCode === 'string' ? error.errorCode : null;
  if (code && DEFINITIVE_ERRORS.has(code)) return code;
  return DEFINITIVE_ERROR_NAMES.get(error?.name) || null;
}

/**
 * A PKCE pair (RFC 7636, S256).
 * @returns {{codeVerifier: string, codeChallenge: string}}
 */
export function createPkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Space-separated scope string → list (empty entries dropped).
 * @param {string|string[]|null|undefined} scope
 * @returns {string[]}
 */
export function parseScope(scope) {
  if (Array.isArray(scope)) return scope.filter(s => typeof s === 'string' && s);
  if (typeof scope !== 'string') return [];
  return scope.split(/\s+/).filter(Boolean);
}

/**
 * The union of several scope lists, in first-seen order.
 * @param {...(string|string[]|null|undefined)} lists
 * @returns {string[]}
 */
export function unionScopes(...lists) {
  const out = [];
  for (const list of lists) {
    for (const scope of parseScope(list)) if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

/**
 * Parse a `WWW-Authenticate: Bearer …` challenge (RFC 6750 §3).
 * @param {string|null|undefined} header
 * @returns {{scheme: string|null, params: Object<string, string>}}
 */
export function parseWwwAuthenticate(header) {
  if (typeof header !== 'string' || !header.trim()) return { scheme: null, params: {} };
  const match = header.trim().match(/^([A-Za-z][A-Za-z0-9-]*)\s*(.*)$/s);
  if (!match) return { scheme: null, params: {} };
  const params = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(match[2])) !== null) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return { scheme: match[1], params };
}

/**
 * Scope step-up (MCP authorization spec, "insufficient_scope"): when a
 * resource answers `403` with `error="insufficient_scope"`, the client asks
 * once more for the **union** of what it already holds and what the challenge
 * names. A second refusal after a step-up is final: this returns null and the
 * caller reports `insufficient_scope` instead of looping.
 *
 * @param {Object} params
 * @param {string[]|string} params.granted - Scopes the connection holds
 * @param {string|Object} params.challenge - The `WWW-Authenticate` header, or its parsed form
 * @param {string[]|string} [params.requested] - Scopes the original sign-in asked for
 * @param {boolean} [params.alreadySteppedUp=false] - Whether this connection already stepped up once
 * @returns {{scopes: string[]}|null} The scopes to re-authorize with, or null when no step-up applies
 *
 * @example
 *   stepUpScopes({ granted: ['read'], challenge: 'Bearer error="insufficient_scope", scope="write"' })
 *   // → { scopes: ['read', 'write'] }
 */
export function stepUpScopes({ granted, challenge, requested = [], alreadySteppedUp = false }) {
  if (alreadySteppedUp) return null;
  const parsed = typeof challenge === 'string' ? parseWwwAuthenticate(challenge) : challenge;
  if (parsed?.params?.error !== 'insufficient_scope') return null;
  const needed = parseScope(parsed.params.scope);
  const scopes = unionScopes(granted, requested, needed);
  const held = new Set(parseScope(granted));
  if (scopes.every(scope => held.has(scope))) return null;
  return { scopes };
}

/**
 * RFC 9207 mix-up defence: an `iss` on the authorization response must name
 * the issuer the request went to, and a missing one is refused when the
 * server promised to send it.
 *
 * @param {Object} params
 * @param {string|undefined} params.iss - `iss` query parameter (undefined when absent)
 * @param {string} params.expectedIssuer
 * @param {boolean} [params.issRequired=false]
 * @throws {OAuthFlowError} `issuer_mismatch`
 */
export function checkAuthorizationResponseIssuer({ iss, expectedIssuer, issRequired = false }) {
  if (typeof iss === 'string' && iss) {
    if (iss !== expectedIssuer) {
      throw new OAuthFlowError(
        OAUTH_FLOW_ERROR_CODES.ISSUER_MISMATCH,
        'Authorization response names another issuer'
      );
    }
    return;
  }
  if (iss !== undefined || issRequired) {
    throw new OAuthFlowError(
      OAUTH_FLOW_ERROR_CODES.ISSUER_MISMATCH,
      'Authorization response without the required iss parameter'
    );
  }
}

/**
 * The authorization request URL (authorization code + PKCE S256).
 *
 * @param {Object} params
 * @param {Object} params.metadata - At least `authorization_endpoint`
 * @param {string} params.clientId
 * @param {string} params.redirectUri
 * @param {string} params.codeChallenge
 * @param {string} [params.state]
 * @param {string} [params.scope] - Space-separated
 * @param {string} [params.resource] - RFC 8707 resource indicator
 * @param {Object<string, string>} [params.extraParams] - Provider-specific (`audience`, `response_mode`, …)
 * @returns {URL}
 * @throws {OAuthFlowError} `discovery_failed` when the server cannot do code + S256
 */
export function buildAuthorizationUrl({
  metadata,
  clientId,
  redirectUri,
  codeChallenge,
  state,
  scope,
  resource,
  extraParams = {}
}) {
  if (!metadata?.authorization_endpoint) {
    throw new OAuthFlowError(OAUTH_FLOW_ERROR_CODES.DISCOVERY_FAILED, 'No authorization endpoint');
  }
  const responseTypes = metadata.response_types_supported;
  if (Array.isArray(responseTypes) && !responseTypes.includes('code')) {
    throw new OAuthFlowError(
      OAUTH_FLOW_ERROR_CODES.DISCOVERY_FAILED,
      'Authorization server does not support the code response type'
    );
  }
  const methods = metadata.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new OAuthFlowError(
      OAUTH_FLOW_ERROR_CODES.DISCOVERY_FAILED,
      'Authorization server does not support PKCE S256'
    );
  }
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', String(redirectUri));
  if (state) url.searchParams.set('state', state);
  if (scope) url.searchParams.set('scope', scope);
  // OIDC: offline_access is only honoured with an explicit consent prompt.
  if (scope && parseScope(scope).includes('offline_access')) {
    url.searchParams.set('prompt', 'consent');
  }
  if (resource) url.searchParams.set('resource', String(resource));
  for (const [key, value] of Object.entries(extraParams || {})) {
    if (typeof value === 'string' && value) url.searchParams.set(key, value);
  }
  return url;
}

/** Apply the client authentication method to a token or revocation request. */
function applyClientAuthentication(method, clientInformation, headers, params) {
  const { client_id: clientId, client_secret: clientSecret } = clientInformation || {};
  if (!clientId) return;
  if (method === 'client_secret_basic' && clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    return;
  }
  params.set('client_id', clientId);
  if (method === 'client_secret_post' && clientSecret) params.set('client_secret', clientSecret);
}

const CLIENT_AUTH_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'none']);

/**
 * RFC 8414 client authentication negotiation (the rule the MCP SDK applies):
 * the method the registration named, when the server supports it; without
 * server metadata `client_secret_basic` for a client with a secret (RFC 8414
 * §2 default); else the most secure method both sides support.
 *
 * @param {{client_secret?: string, token_endpoint_auth_method?: string}} clientInformation
 * @param {string[]} supportedMethods - `token_endpoint_auth_methods_supported`
 * @returns {'client_secret_basic'|'client_secret_post'|'none'}
 */
export function selectClientAuthMethod(clientInformation, supportedMethods = []) {
  const hasSecret = Boolean(clientInformation?.client_secret);
  const hinted = clientInformation?.token_endpoint_auth_method;
  if (
    hinted &&
    CLIENT_AUTH_METHODS.has(hinted) &&
    (supportedMethods.length === 0 || supportedMethods.includes(hinted))
  ) {
    return hinted;
  }
  if (supportedMethods.length === 0) return hasSecret ? 'client_secret_basic' : 'none';
  if (hasSecret && supportedMethods.includes('client_secret_basic')) return 'client_secret_basic';
  if (hasSecret && supportedMethods.includes('client_secret_post')) return 'client_secret_post';
  if (supportedMethods.includes('none')) return 'none';
  return hasSecret ? 'client_secret_post' : 'none';
}

/**
 * Which client authentication a request uses: the strategy's fixed choice, or
 * the negotiation of {@link selectClientAuthMethod}.
 */
function clientAuthMethodFor(context) {
  if (context.clientAuthMethod) return context.clientAuthMethod;
  return selectClientAuthMethod(
    context.clientInformation || {},
    context.metadata?.token_endpoint_auth_methods_supported ?? []
  );
}

/** Read an error answer of a token endpoint without trusting its shape. */
async function tokenErrorFrom(response) {
  let body = null;
  try {
    body = typeof response.json === 'function' ? await response.json() : null;
  } catch {
    body = null;
  }
  const errorCode = typeof body?.error === 'string' ? body.error : undefined;
  const errorDescription =
    typeof body?.error_description === 'string' ? body.error_description.slice(0, 512) : undefined;
  return new OAuthTokenError(
    `Token endpoint answered HTTP ${response.status}${errorCode ? ` (${errorCode})` : ''}`,
    { errorCode, status: response.status, errorDescription }
  );
}

/**
 * One request to a token endpoint.
 *
 * @param {Object} params
 * @param {OAuthServerContext} params.context
 * @param {URLSearchParams} params.params - Grant parameters
 * @returns {Promise<Object>} The raw token response (every field kept)
 * @throws {OAuthTokenError}
 */
export async function tokenRequest({ context, params }) {
  const endpoint = context.metadata?.token_endpoint;
  if (!endpoint) throw new OAuthTokenError('No token endpoint');
  if (context.resource) params.set('resource', String(context.resource));
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json'
  };
  applyClientAuthentication(
    clientAuthMethodFor(context),
    context.clientInformation,
    headers,
    params
  );
  let response;
  try {
    response = await context.fetchFn(String(endpoint), {
      method: 'POST',
      headers,
      body: params.toString()
    });
  } catch (error) {
    throw new OAuthTokenError(`Token endpoint not reachable: ${error?.message || error}`);
  }
  if (!response.ok) throw await tokenErrorFrom(response);
  let raw;
  try {
    raw = await response.json();
  } catch {
    throw new OAuthTokenError('Token endpoint answered with an unparsable body', {
      status: response.status
    });
  }
  if (!raw || typeof raw.access_token !== 'string' || !raw.access_token) {
    throw new OAuthTokenError('Token response without an access_token', {
      status: response.status
    });
  }
  return raw;
}

/**
 * A raw token response in the shape the rest of iHub reads.
 *
 * @param {Object} raw - Token endpoint answer
 * @param {string} [previousRefreshToken] - Kept when the server did not rotate it
 * @returns {NormalizedTokens}
 */
export function normalizeTokenResponse(raw, previousRefreshToken) {
  const expiresIn = Number(raw?.expires_in);
  return {
    accessToken: raw.access_token,
    refreshToken:
      typeof raw.refresh_token === 'string' && raw.refresh_token
        ? raw.refresh_token
        : previousRefreshToken || undefined,
    tokenType: typeof raw.token_type === 'string' ? raw.token_type : 'bearer',
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    idToken: typeof raw.id_token === 'string' ? raw.id_token : undefined,
    raw
  };
}

/**
 * @typedef {Object} OAuthServerContext
 * @property {string} issuer - Issuer identifier the credentials are keyed by
 * @property {string} authorizationServerUrl
 * @property {Object} metadata - RFC 8414 metadata (or the fixed endpoints in that shape)
 * @property {{client_id: string, client_secret?: string, token_endpoint_auth_method?: string}} clientInformation
 * @property {('client_secret_post'|'client_secret_basic'|'none')} [clientAuthMethod] - Fixed choice; else negotiated
 * @property {string[]} scopes - What a sign-in asks for
 * @property {string} [resource] - RFC 8707 resource indicator
 * @property {Object<string, string>} [extraAuthorizationParams]
 * @property {Object<string, string>} [extraRefreshParams]
 * @property {boolean} [issRequired] - RFC 9207 `iss` is mandatory on the authorization response
 * @property {(url: string, init?: Object) => Promise<Response>} fetchFn
 */

/**
 * @typedef {Object} NormalizedTokens
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {string} tokenType
 * @property {number} [expiresIn]
 * @property {string} [scope]
 * @property {string} [idToken]
 * @property {Object} raw - Every field the server answered with
 */

/**
 * @typedef {Object} OAuthStrategy
 * @property {string} id - e.g. `fixed:jira`, `mcp-discovery`
 * @property {(ctx: Object) => Promise<OAuthServerContext>} resolve - `ctx.purpose` is
 *   `authorize` | `exchange` | `refresh` | `revoke`; the MCP strategy also reads
 *   `publicBase` / `trustedBase` / `redirectUri` from it
 */

/**
 * Whether tokens bound to `binding` belong to the server and client of
 * `context` (credentials are keyed by issuer). A binding that names neither
 * (tokens from before bindings existed) matches.
 *
 * @param {{authorizationServerUrl?: string, clientId?: string}} binding
 * @param {OAuthServerContext} context
 * @returns {boolean}
 */
export function bindingMatches(binding = {}, context = {}) {
  if (
    binding.authorizationServerUrl &&
    binding.authorizationServerUrl !== String(context.authorizationServerUrl)
  ) {
    return false;
  }
  return !(binding.clientId && binding.clientId !== context.clientInformation?.client_id);
}

export class OAuthUserClient {
  /**
   * @param {Object} options
   * @param {OAuthStrategy} options.strategy
   */
  constructor({ strategy }) {
    if (!strategy || typeof strategy.resolve !== 'function') {
      throw new Error('OAuthUserClient needs a strategy');
    }
    this.strategy = strategy;
  }

  /**
   * Start a sign-in: resolve the server, make a PKCE pair and the
   * authorization URL. The caller keeps the verifier server-side and adds the
   * `state` (see `oauthFlowStore.js`).
   *
   * @param {Object} params
   * @param {string} params.redirectUri
   * @param {string} [params.state]
   * @param {string[]} [params.scopes] - Replace the strategy's scopes
   * @param {string[]} [params.extraScopes] - Step-up: added to the scopes (union, once)
   * @param {Object} [params.ctx] - Strategy context
   * @returns {Promise<{authorizationUrl: URL, codeVerifier: string, issuer: string, authorizationServerUrl: string, clientId: string, issRequired: boolean, resource: (string|undefined), scopes: string[]}>}
   */
  async startAuthorization({ redirectUri, state, scopes, extraScopes = [], ctx = {} }) {
    const context = await this.strategy.resolve({ ...ctx, purpose: 'authorize', redirectUri });
    const { codeVerifier, codeChallenge } = createPkcePair();
    const requested = unionScopes(
      scopes && scopes.length ? scopes : context.scopes || [],
      extraScopes
    );
    const authorizationUrl = buildAuthorizationUrl({
      metadata: context.metadata,
      clientId: context.clientInformation.client_id,
      redirectUri,
      codeChallenge,
      state,
      scope: requested.length ? requested.join(' ') : undefined,
      resource: context.resource,
      extraParams: context.extraAuthorizationParams
    });
    return {
      authorizationUrl,
      codeVerifier,
      issuer: context.issuer,
      authorizationServerUrl: String(context.authorizationServerUrl),
      clientId: context.clientInformation.client_id,
      issRequired: context.issRequired === true,
      resource: context.resource ? String(context.resource) : undefined,
      scopes: requested
    };
  }

  /**
   * Exchange an authorization code. The code is only sent when the server and
   * client the strategy resolves now are the ones the sign-in started with
   * (`expected`), never to whatever registration happens to be current.
   *
   * @param {Object} params
   * @param {string} params.code
   * @param {string} params.codeVerifier
   * @param {string} params.redirectUri - Exactly what the authorization request sent
   * @param {{authorizationServerUrl?: string, clientId?: string, resource?: string}} [params.expected]
   * @param {Object} [params.ctx]
   * @returns {Promise<{tokens: NormalizedTokens, context: OAuthServerContext}>}
   * @throws {OAuthFlowError} `exchange_failed` (with `cause` the token error)
   */
  async exchangeCode({ code, codeVerifier, redirectUri, expected = {}, ctx = {} }) {
    const context = await this.strategy.resolve({ ...ctx, purpose: 'exchange', redirectUri });
    if (
      (expected.authorizationServerUrl &&
        String(context.authorizationServerUrl) !== expected.authorizationServerUrl) ||
      (expected.clientId && context.clientInformation?.client_id !== expected.clientId)
    ) {
      throw new OAuthFlowError(
        OAUTH_FLOW_ERROR_CODES.EXCHANGE_FAILED,
        'The OAuth client registration changed since the sign-in started'
      );
    }
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: String(redirectUri)
    });
    const requestContext = expected.resource
      ? { ...context, resource: expected.resource }
      : context;
    try {
      const raw = await tokenRequest({ context: requestContext, params });
      return { tokens: normalizeTokenResponse(raw), context };
    } catch (error) {
      const flowError = new OAuthFlowError(
        definitiveOAuthRejection(error) === 'invalid_client'
          ? OAUTH_FLOW_ERROR_CODES.INVALID_CLIENT
          : OAUTH_FLOW_ERROR_CODES.EXCHANGE_FAILED,
        error.message
      );
      flowError.cause = error;
      throw flowError;
    }
  }

  /**
   * Refresh an access token at the issuer that issued it. A refresh token
   * whose binding names another issuer or client is never sent (it would
   * leak to a server that did not issue it).
   *
   * @param {Object} params
   * @param {string} params.refreshToken
   * @param {{issuer?: string, authorizationServerUrl?: string, clientId?: string, resource?: string}} [params.binding]
   * @param {Object} [params.ctx]
   * @param {Function} [params.refreshFn] - Test seam with the MCP SDK's
   *   `refreshAuthorization(authorizationServerUrl, {metadata, clientInformation, refreshToken, resource, fetchFn})` signature
   * @returns {Promise<NormalizedTokens>}
   * @throws {OAuthTokenError} `errorCode: 'other_client'` for a binding mismatch, else the server's answer
   */
  async refresh({ refreshToken, binding = {}, ctx = {}, refreshFn }) {
    const context = await this.strategy.resolve({ ...ctx, purpose: 'refresh' });
    if (!bindingMatches(binding, context)) {
      throw new OAuthTokenError('Tokens were issued to another client', {
        errorCode: 'other_client'
      });
    }
    const resource = binding.resource || context.resource;
    if (refreshFn) {
      const raw = await refreshFn(String(context.authorizationServerUrl), {
        metadata: context.metadata,
        clientInformation: context.clientInformation,
        refreshToken,
        ...(resource ? { resource: new URL(resource) } : {}),
        fetchFn: context.fetchFn
      });
      return normalizeTokenResponse(raw, refreshToken);
    }
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
    for (const [key, value] of Object.entries(context.extraRefreshParams || {})) {
      if (typeof value === 'string' && value) params.set(key, value);
    }
    const raw = await tokenRequest({
      context: { ...context, resource: resource || undefined },
      params
    });
    return normalizeTokenResponse(raw, refreshToken);
  }

  /**
   * Revoke tokens at the issuer's revocation endpoint (RFC 7009), best effort:
   * failures are logged, never thrown.
   *
   * Like {@link refresh}, tokens whose binding names another authorization
   * server or client are never sent: the server the strategy resolves now is
   * not the one that issued them (a repointed MCP server). The caller still
   * deletes them locally.
   *
   * @param {Object} params
   * @param {{accessToken?: string, refreshToken?: string}} params.tokens
   * @param {{authorizationServerUrl?: string, clientId?: string}} [params.binding] - What the tokens were issued for
   * @param {Object} [params.ctx]
   * @returns {Promise<boolean>} True when the server accepted every revocation
   */
  async revoke({ tokens, binding = {}, ctx = {} }) {
    let context;
    try {
      context = await this.strategy.resolve({ ...ctx, purpose: 'revoke' });
    } catch (error) {
      logger.warn('OAuth revocation skipped: the server could not be resolved', {
        component: COMPONENT,
        strategy: this.strategy.id,
        error: error.message
      });
      return false;
    }
    const endpoint = context.metadata?.revocation_endpoint;
    if (!endpoint) return false;
    if (!bindingMatches(binding, context)) {
      logger.warn('OAuth revocation skipped: the tokens were issued by another server or client', {
        component: COMPONENT,
        strategy: this.strategy.id
      });
      return false;
    }
    const candidates = [
      tokens?.refreshToken ? ['refresh_token', tokens.refreshToken] : null,
      tokens?.accessToken ? ['access_token', tokens.accessToken] : null
    ].filter(Boolean);
    let allOk = candidates.length > 0;
    for (const [hint, token] of candidates) {
      const params = new URLSearchParams({ token, token_type_hint: hint });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      const { client_id: clientId, client_secret: clientSecret } = context.clientInformation || {};
      const method = clientSecret ? context.clientAuthMethod || 'client_secret_basic' : 'none';
      if (method === 'client_secret_basic' && clientId) {
        // RFC 6749 §2.3.1: form-encode both parts before the Base64 step.
        headers.Authorization = `Basic ${Buffer.from(
          `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
        ).toString('base64')}`;
      } else {
        applyClientAuthentication(method, context.clientInformation, headers, params);
      }
      try {
        const response = await context.fetchFn(String(endpoint), {
          method: 'POST',
          headers,
          body: params.toString()
        });
        if (!response.ok) allOk = false;
      } catch (error) {
        allOk = false;
        logger.warn('OAuth token revocation failed', {
          component: COMPONENT,
          strategy: this.strategy.id,
          tokenType: hint,
          error: error.message
        });
      }
    }
    return allOk;
  }
}
