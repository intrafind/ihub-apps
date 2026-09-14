/**
 * One resolver for every kind of OAuth client.
 *
 * Two things can answer to a `client_id`:
 *
 *   - `stored` — a record in `oauth-clients.json`: admin service accounts,
 *     personal API keys, and legacy dynamically registered clients.
 *   - `cimd`   — nothing at all: the `client_id` is an HTTPS URL and the
 *     client's identity is the metadata document it hosts there.
 *
 * Every call site that used to do `findClientById(clientsConfig, client_id)`
 * goes through `resolveOAuthClient` instead, and gets back an object with the
 * **same shape** `createOAuthClient` produces plus a `kind` field. Downstream
 * code must not branch on `kind`: the point of the resolver is that the
 * authorize, token, revoke, introspect, userinfo and gateway paths keep one
 * notion of what a client is.
 *
 * @module utils/oauthClientResolver
 */
import { findClientById, loadOAuthClients } from './oauthClientManager.js';
import {
  clientIdHost,
  fetchClientMetadata,
  getCachedClientMetadata,
  isClientIdUrl,
  isHostAllowed
} from './clientIdMetadata.js';
import { DCR_DEFAULT_ALLOWED_SCOPES } from './dcrValidation.js';
import logger from './logger.js';

/**
 * Read the CIMD policy out of the platform config, with the shipped defaults
 * applied so callers never have to spell them out.
 *
 * @param {Object} platform - Platform configuration
 * @returns {Object} Normalized `oauth.cimd` policy
 */
export function getCimdConfig(platform = {}) {
  const oauthConfig = platform.oauth || {};
  const cimd = oauthConfig.cimd || {};

  return {
    enabled: cimd.enabled === true && oauthConfig.enabled?.authz === true,
    allowedClientHosts: Array.isArray(cimd.allowedClientHosts)
      ? cimd.allowedClientHosts
      : ['claude.ai'],
    allowedGroups: Array.isArray(cimd.allowedGroups) ? cimd.allowedGroups : [],
    allowedScopes:
      Array.isArray(cimd.allowedScopes) && cimd.allowedScopes.length > 0
        ? cimd.allowedScopes
        : [...DCR_DEFAULT_ALLOWED_SCOPES],
    allowedApps: Array.isArray(cimd.allowedApps) ? cimd.allowedApps : [],
    allowedModels: Array.isArray(cimd.allowedModels) ? cimd.allowedModels : [],
    allowedPrompts: Array.isArray(cimd.allowedPrompts) ? cimd.allowedPrompts : [],
    tokenExpirationMinutes:
      cimd.tokenExpirationMinutes || oauthConfig.defaultTokenExpirationMinutes || 60,
    cacheMaxSeconds: cimd.cacheMaxSeconds,
    fetchTimeoutMs: cimd.fetchTimeoutMs
  };
}

/**
 * Build a client object from a metadata document and the CIMD policy.
 *
 * A CIMD client is never trusted and always requires consent. There is no
 * administrator anywhere in its creation — a client declared itself by
 * publishing a document — so the consent screen is the only authorization
 * gate, and `trusted` must not become settable for it by any path.
 *
 * `active` is computed rather than stored, which is what makes disabling CIMD
 * (or dropping a host from the allowlist) an immediate kill switch for every
 * token already issued to such a client.
 *
 * @param {Object} metadata - Validated document metadata
 * @param {Object} cimdConfig - Normalized policy from {@link getCimdConfig}
 * @returns {Object} Client object shaped like `createOAuthClient` output
 */
export function buildCimdClient(metadata, cimdConfig) {
  const host = clientIdHost(metadata.clientId);

  return {
    id: metadata.clientId,
    clientId: metadata.clientId,
    name: metadata.name,
    description: `Client metadata document at ${host}`,
    clientSecret: null,
    scopes: [...cimdConfig.allowedScopes],
    allowedApps: [...cimdConfig.allowedApps],
    allowedModels: [...cimdConfig.allowedModels],
    allowedPrompts: [...cimdConfig.allowedPrompts],
    allowedGroups: [...cimdConfig.allowedGroups],
    tokenExpirationMinutes: cimdConfig.tokenExpirationMinutes,
    active: cimdConfig.enabled && isHostAllowed(metadata.clientId, cimdConfig.allowedClientHosts),
    createdAt: null,
    createdBy: 'cimd',
    lastUsed: null,
    lastRotated: null,
    metadata: { cimd: true, host, clientUri: metadata.clientUri || '' },
    clientType: 'public',
    grantTypes: [...metadata.grantTypes],
    redirectUris: [...metadata.redirectUris],
    postLogoutRedirectUris: [],
    consentRequired: true,
    trusted: false,
    personal: false,
    ownerUserId: null,
    ownerUsername: null,
    ownerName: null,
    ownerEmail: null,
    ownerGroups: [],
    kind: 'cimd',
    host
  };
}

/**
 * Resolve a `client_id` to a client object.
 *
 * @param {string} clientId - The presented `client_id`
 * @param {Object} platform - Platform configuration
 * @param {Object} [options]
 * @param {boolean} [options.allowFetch=false] - Whether a cache miss may make
 *   a network call. True on the authorization endpoint, false everywhere on
 *   the request path (`mcpAuth`) and on the token endpoint, which must not
 *   depend on the client's host being reachable.
 * @returns {Promise<{ok: true, client: Object} |
 *           {ok: false, error: string, reason: string, host?: string}>}
 */
export async function resolveOAuthClient(clientId, platform = {}, options = {}) {
  const oauthConfig = platform.oauth || {};
  const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';

  if (!isClientIdUrl(clientId)) {
    const clientsConfig = loadOAuthClients(clientsFilePath);
    if (clientsConfig?.metadata?.error) {
      return {
        ok: false,
        error: 'server_error',
        reason: 'OAuth client store unavailable'
      };
    }
    const stored = findClientById(clientsConfig, clientId);
    if (!stored) {
      return { ok: false, error: 'invalid_client', reason: 'unknown client_id' };
    }
    return { ok: true, client: { ...stored, kind: 'stored', host: null } };
  }

  const cimdConfig = getCimdConfig(platform);
  const host = clientIdHost(clientId);

  if (!cimdConfig.enabled) {
    return {
      ok: false,
      error: 'invalid_client',
      reason: 'client metadata documents are not enabled on this server',
      host
    };
  }

  // Before any network call: an unlisted host must never cause an outbound
  // request, or the authorize endpoint becomes a request forwarder.
  if (!isHostAllowed(clientId, cimdConfig.allowedClientHosts)) {
    logger.warn('[OAuth CIMD] Rejected client from a host that is not allowed', {
      component: 'OAuthClientResolver',
      host
    });
    return {
      ok: false,
      error: 'invalid_client',
      reason: 'client host is not allowed on this server',
      host
    };
  }

  const cached = getCachedClientMetadata(clientId);
  if (cached) {
    return { ok: true, client: buildCimdClient(cached, cimdConfig) };
  }

  if (options.allowFetch !== true) {
    return {
      ok: false,
      error: 'invalid_client',
      reason: 'client metadata document is not available',
      host
    };
  }

  const fetched = await fetchClientMetadata(clientId, {
    timeoutMs: cimdConfig.fetchTimeoutMs,
    cacheMaxSeconds: cimdConfig.cacheMaxSeconds
  });
  if (!fetched.ok) {
    logger.warn('[OAuth CIMD] Client metadata document rejected', {
      component: 'OAuthClientResolver',
      host,
      reason: fetched.reason
    });
    return { ok: false, error: 'invalid_client', reason: fetched.reason, host };
  }

  return { ok: true, client: buildCimdClient(fetched.metadata, cimdConfig) };
}

/**
 * Build a CIMD client from policy alone, with no document and no fetch.
 *
 * Used on the gateway request path and on token exchange/refresh, where the
 * grant that is being presented already carries the binding a document would
 * add: the access token was issued for this `client_id`, and the code or
 * refresh entry pins `client_id`, `redirect_uri` and the PKCE verifier. What
 * still has to be re-checked on every request is the *policy* — CIMD enabled,
 * host still allowed — which is exactly what this returns.
 *
 * @param {string} clientId - CIMD client identifier (an HTTPS URL)
 * @param {Object} platform - Platform configuration
 * @returns {Object|null} Client object, or null when policy no longer allows it
 */
export function buildPolicyCimdClient(clientId, platform = {}) {
  if (!isClientIdUrl(clientId)) return null;

  const cimdConfig = getCimdConfig(platform);
  if (!cimdConfig.enabled) return null;
  if (!isHostAllowed(clientId, cimdConfig.allowedClientHosts)) return null;

  const cached = getCachedClientMetadata(clientId);
  const host = clientIdHost(clientId);

  return buildCimdClient(
    cached || {
      clientId,
      name: host,
      clientUri: '',
      // No document to hand out redirect URIs from. Nothing on these paths
      // matches a redirect URI — the authorization request already did — and
      // an empty list would read as "authorization_code disabled", so the
      // grant types are declared and the URI list stays empty by design.
      redirectUris: [],
      grantTypes: ['authorization_code', 'refresh_token']
    },
    cimdConfig
  );
}
