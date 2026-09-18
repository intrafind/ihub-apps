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
import { findCimdClientPolicy, findClientById, loadOAuthClients } from './oauthClientManager.js';
import {
  clientIdHost,
  fetchClientMetadata,
  getCachedClientMetadata,
  isClientIdUrl
} from './clientIdMetadata.js';
import {
  approvalSatisfied,
  effectiveField,
  evaluateCimdAccess,
  evaluateCimdActivation
} from './oauthClientPolicy.js';
import { DCR_DEFAULT_ALLOWED_SCOPES } from './dcrValidation.js';
import logger from './logger.js';

/** Where the client store lives, with the shipped default applied. */
function clientsFileFor(platform) {
  return platform?.oauth?.clientsFile || 'contents/config/oauth-clients.json';
}

/**
 * A copy of a policy list, tolerating a store that was edited by hand.
 *
 * The admin API validates what it writes, but `oauth-clients.json` is a file an
 * operator can open. A string where a list belongs must narrow nothing rather
 * than throw on the request path.
 *
 * @param {*} value - The effective value for a list-shaped policy field
 * @returns {Array<string>} The list, or an empty one
 */
function policyList(value) {
  return Array.isArray(value) ? [...value] : [];
}

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
    blockedClientHosts: Array.isArray(cimd.blockedClientHosts) ? cimd.blockedClientHosts : [],
    // `approval` is the shipped default: passing the host allowlist makes a
    // client eligible, not allowed. An installation that wants the allowlist
    // to be the whole decision sets `auto` explicitly.
    approvalMode: cimd.approvalMode === 'auto' ? 'auto' : 'approval',
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
 * Build a client object from a metadata document and the effective policy.
 *
 * A CIMD client is never trusted and always requires consent. There is no
 * administrator anywhere in its creation — a client declared itself by
 * publishing a document — so the consent screen is the only authorization
 * gate, and `trusted` must not become settable for it by any path. Approving
 * a client is not trusting it: an approved client still sends every user
 * through sign-in and consent.
 *
 * Identity — name, redirect URIs, grant types — comes from the document.
 * Policy comes from the stored record layered over the platform defaults,
 * field by field, so an administrator who set a global `allowedApps` and then
 * narrows one client's `allowedGroups` keeps the global apps list on it.
 *
 * `active` is computed rather than stored, which is what makes each of
 * disabling CIMD, blocking the host, blocking the client and withdrawing its
 * approval an immediate kill switch for every token already issued to it.
 *
 * @param {Object} metadata - Validated document metadata
 * @param {Object} cimdConfig - Normalized policy from {@link getCimdConfig}
 * @param {Object|null} [record] - Stored per-client policy record, if any
 * @returns {Object} Client object shaped like `createOAuthClient` output
 */
export function buildCimdClient(metadata, cimdConfig, record = null) {
  const host = clientIdHost(metadata.clientId);
  const activation = evaluateCimdActivation(metadata.clientId, cimdConfig, record);

  return {
    id: metadata.clientId,
    clientId: metadata.clientId,
    name: metadata.name,
    description: `Client metadata document at ${host}`,
    clientSecret: null,
    scopes: policyList(effectiveField(record, cimdConfig, 'scopes', 'allowedScopes')),
    allowedApps: policyList(effectiveField(record, cimdConfig, 'allowedApps')),
    allowedModels: policyList(effectiveField(record, cimdConfig, 'allowedModels')),
    allowedPrompts: policyList(effectiveField(record, cimdConfig, 'allowedPrompts')),
    allowedGroups: policyList(effectiveField(record, cimdConfig, 'allowedGroups')),
    tokenExpirationMinutes: effectiveField(record, cimdConfig, 'tokenExpirationMinutes'),
    active: activation.active,
    inactiveCode: activation.code || null,
    approvalState: record?.approvalState || null,
    hasPolicyRecord: !!record,
    createdAt: record?.createdAt || null,
    createdBy: 'cimd',
    lastUsed: record?.lastUsed || null,
    lastRotated: null,
    metadata: {
      ...(record?.metadata || {}),
      cimd: true,
      host,
      clientUri: metadata.clientUri || ''
    },
    clientType: 'public',
    grantTypes: [...metadata.grantTypes],
    redirectUris: [...metadata.redirectUris],
    postLogoutRedirectUris: [],
    // Locked by definition, for both kinds of record: a client that declared
    // itself cannot also be pre-approved to skip the user's decision.
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
 *           {ok: false, error: string, reason: string, code?: string,
 *            host?: string, clientName?: string}>}
 */
export async function resolveOAuthClient(clientId, platform = {}, options = {}) {
  const clientsFilePath = clientsFileFor(platform);

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
  const record = findCimdClientPolicy(clientId, clientsFilePath);

  // Refusals that need no document are decided first, because none of them may
  // cause a network call: an unlisted or blocked host must never make the
  // authorize endpoint issue an outbound request on a caller-supplied URL.
  const access = evaluateCimdAccess(clientId, cimdConfig, record);
  if (!access.active) {
    logger.warn('[OAuth CIMD] Client refused by policy', {
      component: 'OAuthClientResolver',
      host,
      code: access.code
    });
    return {
      ok: false,
      error: 'invalid_client',
      reason: access.reason,
      code: access.code,
      host,
      clientName: record?.metadata?.displayName || ''
    };
  }

  // The approval gate is evaluated *after* the document, unlike everything
  // above. The host is already allowlisted by this point, so fetching costs no
  // new exposure, and it is what lets the refusal page and the pending row
  // name the software the user actually tried to connect.
  const approvalRefusal = metadata => {
    if (approvalSatisfied(record, cimdConfig.approvalMode)) return null;
    logger.info('[OAuth CIMD] Client awaiting administrator approval', {
      component: 'OAuthClientResolver',
      host,
      clientId
    });
    return {
      ok: false,
      error: 'invalid_client',
      reason: 'this client has not been approved by an administrator',
      code: 'approval_pending',
      host,
      clientId,
      clientName: metadata?.name || record?.metadata?.displayName || ''
    };
  };

  const cached = getCachedClientMetadata(clientId);
  if (cached) {
    return (
      approvalRefusal(cached) || { ok: true, client: buildCimdClient(cached, cimdConfig, record) }
    );
  }

  if (options.allowFetch !== true) {
    return {
      ok: false,
      error: 'invalid_client',
      reason: 'client metadata document is not available',
      code: 'document_unavailable',
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
    return {
      ok: false,
      error: 'invalid_client',
      reason: fetched.reason,
      code: 'document_rejected',
      host
    };
  }

  return (
    approvalRefusal(fetched.metadata) || {
      ok: true,
      client: buildCimdClient(fetched.metadata, cimdConfig, record)
    }
  );
}

/**
 * Build a CIMD client from policy alone, with no document and no fetch.
 *
 * Used on the gateway request path and on token exchange/refresh, where the
 * grant that is being presented already carries the binding a document would
 * add: the access token was issued for this `client_id`, and the code or
 * refresh entry pins `client_id`, `redirect_uri` and the PKCE verifier. What
 * still has to be re-checked on every request is the *policy* — CIMD enabled,
 * host still allowed and not blocked, client not blocked, approval still
 * standing — which is exactly what this returns null for when it fails.
 *
 * @param {string} clientId - CIMD client identifier (an HTTPS URL)
 * @param {Object} platform - Platform configuration
 * @returns {Object|null} Client object, or null when policy no longer allows it
 */
export function buildPolicyCimdClient(clientId, platform = {}) {
  if (!isClientIdUrl(clientId)) return null;

  const cimdConfig = getCimdConfig(platform);
  const record = findCimdClientPolicy(clientId, clientsFileFor(platform));
  if (!evaluateCimdActivation(clientId, cimdConfig, record).active) return null;

  const cached = getCachedClientMetadata(clientId);
  const host = clientIdHost(clientId);

  return buildCimdClient(
    cached || {
      clientId,
      // Display only, and only when no document is cached on this worker. The
      // record never supplies identity — see `buildCimdClient`.
      name: record?.metadata?.displayName || host,
      clientUri: '',
      // No document to hand out redirect URIs from. Nothing on these paths
      // matches a redirect URI — the authorization request already did — and
      // an empty list would read as "authorization_code disabled", so the
      // grant types are declared and the URI list stays empty by design.
      redirectUris: [],
      grantTypes: ['authorization_code', 'refresh_token']
    },
    cimdConfig,
    record
  );
}
