// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The bearer token for every call from iHub to iFinder and iAssistant.
 *
 * Two modes, picked by the iFinder installation's `authMode`:
 *
 *  - `ihubSigned` (default): iHub signs the token itself (`utils/iFinderJwt.js`),
 *    exactly as it always has.
 *  - `oidcTokenExchange`: iHub and iFinder share one OIDC provider. The access
 *    token the user got when signing in to iHub through that provider is kept
 *    (encrypted, `TokenStorageService`, service `oidc-login`), refreshed when it
 *    expires, and exchanged at the provider for a token with the iFinder
 *    audience and scopes: RFC 8693 token exchange (Zitadel, Keycloak) or the
 *    Entra On-Behalf-Of grant. The result is cached in memory per user,
 *    audience and scope until shortly before it expires.
 *
 * Background runs (scheduled tasks, API keys, workflows) have no session; they
 * use the stored refresh token, which is why it is kept after logout. When the
 * provider rejects it for good, the stored tokens are deleted and the run fails
 * with an error asking the user to sign in again.
 *
 * Design: concepts/2026-10-29 Shared OIDC Provider for iFinder (Token Exchange).md
 *
 * @module services/integrations/iFinderTokenProvider
 */
import jwt from 'jsonwebtoken';
import configCache from '../../configCache.js';
import { getIFinderConfig } from './ifinderConfig.js';
import tokenStorageService from '../TokenStorageService.js';
import credentialService from '../CredentialService.js';
import { tokenStorageIdFor } from '../mcp/mcpUserTokens.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import { httpFetch } from '../../utils/httpConfig.js';
import { withFileLock } from '../../utils/fileLock.js';
import { publish, subscribe } from '../../clusterBus.js';
import logger from '../../utils/logger.js';
import {
  OAuthRefreshError,
  REFRESH_ERROR_CODES,
  createUnavailableError,
  isTerminalRefreshError,
  refreshFailureFromResponse
} from './oauthRefreshError.js';

const COMPONENT = 'iFinderTokenProvider';

export const IFINDER_AUTH_MODES = Object.freeze({
  IHUB_SIGNED: 'ihubSigned',
  OIDC_TOKEN_EXCHANGE: 'oidcTokenExchange'
});

export const TOKEN_EXCHANGE_GRANT_TYPES = Object.freeze({
  /** RFC 8693 (Zitadel, Keycloak). */
  TOKEN_EXCHANGE: 'tokenExchange',
  /** Microsoft Entra ID On-Behalf-Of. */
  ENTRA_OBO: 'entraObo'
});

/** TokenStorageService service name of the stored OIDC login tokens. */
export const OIDC_LOGIN_TOKEN_SERVICE = 'oidc-login';

/** Error codes callers (and the profile page) can act on. */
export const IFINDER_AUTH_ERROR_CODES = Object.freeze({
  /** The user signed in through the right provider, but iHub holds no usable token. */
  REAUTHORIZATION_REQUIRED: 'ifinder_reauthorization_required',
  /** The user signed in some other way (local, LDAP, NTLM, another provider). */
  SIGN_IN_REQUIRED: 'ifinder_sign_in_required',
  /** The exchange is not configured correctly. */
  CONFIGURATION: 'ifinder_token_exchange_configuration',
  /** The provider refused the exchange. */
  EXCHANGE_FAILED: 'ifinder_token_exchange_failed'
});

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

/** An exchanged token is reused until this long before it expires. */
const EXPIRY_SKEW_MS = 60_000;
/** Above this many cached tokens, expired ones are pruned on every insert. */
const CACHE_PRUNE_THRESHOLD = 500;
/** Provider error codes that say the subject token (not the client) was rejected. */
const SUBJECT_TOKEN_REJECTED = new Set(['invalid_grant', 'invalid_token']);

/** @type {Map<string, {token: string, expiresAtMs: number, userId: string}>} */
const exchangedTokens = new Map();
/** @type {Map<string, Promise<string>>} One exchange in flight per cache key. */
const inFlight = new Map();
/**
 * Bumped by every clear. An exchange that started before a clear (a revoke,
 * a deactivation, a config change) must not put its token into the cache.
 */
let cacheGeneration = 0;

/** Cluster channel: another worker cleared its cache; clear ours too. */
const CACHE_CLEAR_CHANNEL = 'ifinder-token-exchange:clear';

function errorWithCode(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, extra);
}

function configurationError(message) {
  return errorWithCode(message, IFINDER_AUTH_ERROR_CODES.CONFIGURATION);
}

/**
 * @param {Object} [iFinderConfig] - the iFinder connection (`getIFinderConfig()`)
 * @returns {'ihubSigned'|'oidcTokenExchange'}
 */
export function getAuthMode(iFinderConfig) {
  return iFinderConfig?.authMode === IFINDER_AUTH_MODES.OIDC_TOKEN_EXCHANGE
    ? IFINDER_AUTH_MODES.OIDC_TOKEN_EXCHANGE
    : IFINDER_AUTH_MODES.IHUB_SIGNED;
}

/**
 * The name of the OIDC provider whose login tokens iHub keeps for iFinder, or
 * null when the exchange mode is off.
 * @param {Object} [platform]
 * @returns {string|null}
 */
export function getExchangeProviderName(platform, iFinder = getIFinderConfig()) {
  if (getAuthMode(iFinder) !== IFINDER_AUTH_MODES.OIDC_TOKEN_EXCHANGE) return null;
  return iFinder.tokenExchange?.oidcProvider || null;
}

/**
 * Whether a sign-in through `providerName` should keep its tokens: only for the
 * provider the iFinder exchange is configured to use, and only in that mode, so
 * an ordinary OIDC deployment stores nothing.
 * @param {string} providerName
 * @param {Object} [platform]
 * @returns {boolean}
 */
export function shouldStoreLoginTokens(providerName, platform, iFinder = getIFinderConfig()) {
  return Boolean(providerName) && getExchangeProviderName(platform, iFinder) === providerName;
}

/** The OIDC providers configured on this installation, enabled or not. */
function oidcProviders(platform) {
  return Array.isArray(platform.oidcAuth?.providers) ? platform.oidcAuth.providers : [];
}

/**
 * Everything the exchange needs, read from the current configuration. Secrets
 * are resolved where they are used, not here.
 * @param {Object} [platform]
 * @returns {Object}
 * @throws {Error} A configuration error naming what is missing
 */
export function resolveExchangeSettings(
  platform = configCache.getPlatform() || {},
  iFinder = getIFinderConfig()
) {
  const exchange = iFinder.tokenExchange || {};
  const providerName = exchange.oidcProvider;
  if (!providerName) {
    throw configurationError(
      'iFinder token exchange has no OIDC provider selected. Name one on the iFinder installation under Admin > Integrations > Installed.'
    );
  }
  const provider = oidcProviders(platform).find(entry => entry.name === providerName);
  if (!provider || provider.enabled === false || platform.oidcAuth?.enabled === false) {
    throw configurationError(
      `iFinder token exchange uses the OIDC provider "${providerName}", which is not configured or not enabled under Admin > Authentication.`
    );
  }
  if (!provider.tokenURL) {
    throw configurationError(`The OIDC provider "${providerName}" has no token URL configured.`);
  }
  const grantType = exchange.grantType || TOKEN_EXCHANGE_GRANT_TYPES.TOKEN_EXCHANGE;
  if (!Object.values(TOKEN_EXCHANGE_GRANT_TYPES).includes(grantType)) {
    throw configurationError(`Unknown iFinder token exchange grant type "${grantType}".`);
  }

  return {
    providerName,
    displayName: provider.displayName || provider.name,
    tokenURL: provider.tokenURL,
    grantType,
    // The provider's login client both refreshes the sign-in (the refresh
    // token was issued to it) and exchanges it.
    clientId: provider.clientId,
    clientSecretRef: provider.clientSecretRef,
    audience: exchange.audience || '',
    scopeMap: exchange.scopeMap && typeof exchange.scopeMap === 'object' ? exchange.scopeMap : {},
    extraScopes: Array.isArray(exchange.extraScopes) ? exchange.extraScopes : [],
    defaultScope: iFinder.defaultScope
  };
}

/**
 * Translate the scope a caller asked for (`fa_index_read`, `fa_iassistant`, …)
 * into the scope string sent to the provider. A scope with an empty or missing
 * `scopeMap` entry passes through unchanged; `extraScopes` are appended.
 * @param {string} scope - Space-separated iHub-side scopes
 * @param {Object} settings - From resolveExchangeSettings
 * @returns {string} Space-separated provider scopes, de-duplicated
 */
export function mapScope(scope, settings) {
  const mapped = String(scope || '')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(entry => {
      const target = Object.hasOwn(settings.scopeMap, entry) ? settings.scopeMap[entry] : '';
      return typeof target === 'string' && target.trim() ? target.trim().split(/\s+/) : [entry];
    });
  const extra = settings.extraScopes.flatMap(entry => String(entry).trim().split(/\s+/));
  return [...new Set([...mapped, ...extra].filter(Boolean))].join(' ');
}

/** The id the user's login tokens are filed under (hashed when not file-name safe). */
function storageIdOf(userId) {
  return tokenStorageIdFor(String(userId));
}

/**
 * Seconds until a JWT's `exp`, or undefined when the token is opaque or has
 * none. Never below 1: the token store reads a lifetime of 0 as "never expires".
 */
function secondsUntilJwtExpiry(token) {
  const exp = jwt.decode(token)?.exp;
  return typeof exp === 'number' ? Math.max(1, exp - Math.floor(Date.now() / 1000)) : undefined;
}

/** `expires_in` as a number of seconds, falling back to the token's own `exp`. */
function lifetimeSeconds(expiresIn, accessToken) {
  const value = Number(expiresIn);
  return Number.isFinite(value) && value > 0 ? value : secondsUntilJwtExpiry(accessToken);
}

function cacheKey(userId, audience, scope) {
  return JSON.stringify([String(userId), audience, scope]);
}

/** Forget this worker's exchanged tokens: all of them (`userId` null), or one user's. */
function clearLocalCache(userId) {
  cacheGeneration += 1;
  if (userId === null || userId === undefined) {
    exchangedTokens.clear();
    return;
  }
  for (const [key, entry] of exchangedTokens) {
    if (entry.userId === String(userId)) exchangedTokens.delete(key);
  }
}

subscribe(CACHE_CLEAR_CHANNEL, payload => clearLocalCache(payload?.userId ?? null));

/**
 * Forget exchanged tokens on every cluster worker: all of them, or one user's.
 * A revoked or deactivated user must stop reaching iFinder on all workers, not
 * only on the one that handled the request; the cache would otherwise keep
 * serving tokens for as long as the provider issued them.
 * @param {string} [userId]
 */
export function clearExchangedTokenCache(userId) {
  const target = userId === undefined ? null : String(userId);
  clearLocalCache(target);
  publish(CACHE_CLEAR_CHANNEL, { userId: target });
}

function pruneExpired(now) {
  if (exchangedTokens.size < CACHE_PRUNE_THRESHOLD) return;
  for (const [key, entry] of exchangedTokens) {
    if (entry.expiresAtMs - EXPIRY_SKEW_MS <= now) exchangedTokens.delete(key);
  }
}

/**
 * Keep the tokens of a sign-in through the exchange provider. Called from the
 * OIDC verify callback; never put them on the user object, which can be written
 * to users.json. A sign-in without a refresh token keeps the one stored before.
 * @param {string} userId
 * @param {string} providerName
 * @param {{accessToken: string, refreshToken?: string, expiresIn?: number}} tokens
 */
export async function storeLoginTokens(
  userId,
  providerName,
  { accessToken, refreshToken, expiresIn }
) {
  if (!accessToken) return;
  const storageId = storageIdOf(userId);
  let keptRefreshToken = refreshToken;
  if (!keptRefreshToken) {
    keptRefreshToken = await tokenStorageService
      .getUserTokens(storageId, OIDC_LOGIN_TOKEN_SERVICE, providerName)
      .then(previous => previous?.refreshToken)
      .catch(() => undefined);
  }
  if (!keptRefreshToken) {
    logger.warn(
      'OIDC sign-in returned no refresh token; iFinder access will end when the access token expires. Add "offline_access" to the provider scopes.',
      { component: COMPONENT, providerName, userId }
    );
  }
  await tokenStorageService.storeUserTokens(
    storageId,
    OIDC_LOGIN_TOKEN_SERVICE,
    {
      accessToken,
      refreshToken: keptRefreshToken,
      expiresIn: lifetimeSeconds(expiresIn, accessToken),
      // When the user signed in. Refreshes keep it; the file's own createdAt
      // moves with every write.
      authorizedAt: new Date().toISOString()
    },
    providerName
  );
  clearExchangedTokenCache(userId);
}

/**
 * Delete a user's stored login tokens (revoke, deactivation, terminal refresh
 * failure). Without `providerName` every provider's tokens of the user go.
 * @param {string} userId
 * @param {string} [providerName]
 * @returns {Promise<boolean>} true when a token file was removed
 */
export async function deleteLoginTokens(userId, providerName) {
  clearExchangedTokenCache(userId);
  const storageId = storageIdOf(userId);
  if (providerName) {
    return tokenStorageService.deleteUserTokens(storageId, OIDC_LOGIN_TOKEN_SERVICE, providerName);
  }
  const removed = await tokenStorageService.deleteAllTokensForStorageIds([storageId], {
    serviceName: OIDC_LOGIN_TOKEN_SERVICE
  });
  return removed > 0;
}

/**
 * Whether the user has a stored background authorization for the exchange
 * provider, and when they signed in to grant it. The tokens themselves never
 * leave this module.
 * @param {string} userId
 * @param {string} providerName
 * @returns {Promise<{authorized: boolean, authorizedAt?: string}>}
 */
export async function getLoginTokenStatus(userId, providerName) {
  try {
    const tokens = await tokenStorageService.getUserTokens(
      storageIdOf(userId),
      OIDC_LOGIN_TOKEN_SERVICE,
      providerName
    );
    return { authorized: true, authorizedAt: tokens.authorizedAt };
  } catch {
    return { authorized: false };
  }
}

/** How a user signed in, as far as the session or task snapshot tells. */
function signInOf(user) {
  return {
    mode: user.authMode || user.authMethod || null,
    provider: user.authProvider || user.provider || null
  };
}

/** The error for a user iHub holds no login token for. */
function missingLoginTokenError(user, settings) {
  const { mode, provider } = signInOf(user);
  if (mode === 'oidc' && provider && provider !== settings.providerName) {
    return errorWithCode(
      `iFinder requires sign-in via ${settings.displayName}. You signed in via another provider ("${provider}"), whose tokens iFinder does not accept.`,
      IFINDER_AUTH_ERROR_CODES.SIGN_IN_REQUIRED,
      { status: 403 }
    );
  }
  if (mode && mode !== 'oidc' && !String(mode).startsWith('oauth_')) {
    return errorWithCode(
      `iFinder requires sign-in via ${settings.displayName}. Your account signed in with "${mode}", which provides no token iFinder accepts.`,
      IFINDER_AUTH_ERROR_CODES.SIGN_IN_REQUIRED,
      { status: 403 }
    );
  }
  return reauthorizationError(settings);
}

function reauthorizationError(settings, cause) {
  return errorWithCode(
    `iFinder access is not authorized. Sign in again via ${settings.displayName} to re-authorize iFinder access.`,
    IFINDER_AUTH_ERROR_CODES.REAUTHORIZATION_REQUIRED,
    { status: 403, ...(cause ? { cause } : {}) }
  );
}

function resolveClientSecret(ref) {
  const secret = ref ? credentialService.tryResolveSecret(ref) : undefined;
  if (!secret) {
    throw configurationError(
      'The client secret of the OIDC provider used for the iFinder token exchange could not be resolved from the credential store.'
    );
  }
  return secret;
}

async function postForm(url, params) {
  const response = await httpFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams(params).toString()
  });
  const data = await response.json().catch(() => ({}));
  return { response, data: data && typeof data === 'object' ? data : {} };
}

/**
 * Refresh the login tokens at the provider with the login client.
 * @returns {Promise<{accessToken: string, refreshToken?: string, expiresIn?: number}>}
 * @throws {OAuthRefreshError}
 */
async function refreshLoginTokens(settings, refreshToken, clientSecret) {
  let result;
  try {
    result = await postForm(settings.tokenURL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: settings.clientId,
      client_secret: clientSecret
    });
  } catch (error) {
    throw new OAuthRefreshError(
      `Failed to refresh the ${settings.displayName} sign-in: ${error.message}`,
      REFRESH_ERROR_CODES.TEMPORARY,
      { cause: error }
    );
  }
  const { response, data } = result;
  if (!response.ok) {
    throw refreshFailureFromResponse(response, data);
  }
  if (!data.access_token) {
    throw new OAuthRefreshError(
      'The token endpoint answered the refresh without an access token',
      REFRESH_ERROR_CODES.TEMPORARY
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in
  };
}

/**
 * Refresh the user's login tokens, holding a per-user lock across cluster
 * workers: Zitadel and Keycloak rotate the refresh token, so two workers
 * refreshing at once would burn it. A worker that waited finds the tokens the
 * other one stored and uses them.
 * @param {Object} user
 * @param {Object} settings
 * @param {string} staleAccessToken - The access token the caller found unusable
 * @returns {Promise<string>} A fresh login access token
 */
async function refreshUnderLock(user, settings, staleAccessToken) {
  const storageId = storageIdOf(user.id);
  const tokenFile = tokenStorageService._tokenFilePath(
    storageId,
    OIDC_LOGIN_TOKEN_SERVICE,
    settings.providerName
  );
  const lockPath = tokenFile.replace(/\.json$/, '.lock');
  const clientSecret = resolveClientSecret(settings.clientSecretRef);

  return withFileLock(
    lockPath,
    async () => {
      let current;
      try {
        current = await tokenStorageService.getUserTokens(
          storageId,
          OIDC_LOGIN_TOKEN_SERVICE,
          settings.providerName
        );
      } catch (error) {
        // Deleted meanwhile (revoked, or another worker's terminal refresh).
        if (/not authenticated/i.test(error?.message || '')) {
          throw missingLoginTokenError(user, settings);
        }
        throw error;
      }
      const expired = await tokenStorageService.areTokensExpired(
        storageId,
        OIDC_LOGIN_TOKEN_SERVICE,
        settings.providerName
      );
      if (current.accessToken !== staleAccessToken && !expired) {
        return current.accessToken;
      }

      try {
        if (!current.refreshToken) {
          throw new OAuthRefreshError('No refresh token stored', REFRESH_ERROR_CODES.MISSING);
        }
        const refreshed = await refreshLoginTokens(settings, current.refreshToken, clientSecret);
        await tokenStorageService.storeUserTokens(
          storageId,
          OIDC_LOGIN_TOKEN_SERVICE,
          {
            accessToken: refreshed.accessToken,
            // Providers that do not rotate answer without a new refresh token.
            refreshToken: refreshed.refreshToken || current.refreshToken,
            expiresIn: lifetimeSeconds(refreshed.expiresIn, refreshed.accessToken),
            authorizedAt: current.authorizedAt
          },
          settings.providerName
        );
        logger.info('Refreshed the OIDC sign-in tokens for iFinder', {
          component: COMPONENT,
          userId: user.id,
          providerName: settings.providerName
        });
        return refreshed.accessToken;
      } catch (error) {
        if (isTerminalRefreshError(error)) {
          logger.warn('OIDC sign-in can no longer be refreshed; stored tokens deleted', {
            component: COMPONENT,
            userId: user.id,
            providerName: settings.providerName,
            code: error.code
          });
          await deleteLoginTokens(user.id, settings.providerName);
          throw reauthorizationError(settings, error);
        }
        logger.error('Refreshing the OIDC sign-in for iFinder failed', {
          component: COMPONENT,
          userId: user.id,
          providerName: settings.providerName,
          error
        });
        throw createUnavailableError(`The sign-in provider ${settings.displayName}`, error);
      }
    },
    { component: COMPONENT, timeoutMs: 15_000, staleMs: 30_000 }
  );
}

/**
 * The user's current login access token, refreshed when it expired (or when
 * `staleAccessToken` names the one the provider just rejected).
 * @returns {Promise<string>}
 */
async function getLoginAccessToken(user, settings, { staleAccessToken } = {}) {
  const storageId = storageIdOf(user.id);
  let tokens;
  try {
    tokens = await tokenStorageService.getUserTokens(
      storageId,
      OIDC_LOGIN_TOKEN_SERVICE,
      settings.providerName
    );
  } catch (error) {
    if (/not authenticated/i.test(error?.message || '')) {
      throw missingLoginTokenError(user, settings);
    }
    throw error;
  }
  if (!staleAccessToken) {
    const expired = await tokenStorageService.areTokensExpired(
      storageId,
      OIDC_LOGIN_TOKEN_SERVICE,
      settings.providerName
    );
    if (!expired) return tokens.accessToken;
  }
  return refreshUnderLock(user, settings, staleAccessToken || tokens.accessToken);
}

/**
 * The form parameters of the exchange request for the configured grant type.
 * @param {Object} settings
 * @param {string} subjectToken - The user's login access token
 * @param {string} scope - Provider scopes (already mapped)
 * @param {string} clientSecret
 * @returns {Object}
 */
export function buildExchangeParams(settings, subjectToken, scope, clientSecret) {
  const params =
    settings.grantType === TOKEN_EXCHANGE_GRANT_TYPES.ENTRA_OBO
      ? {
          grant_type: GRANT_JWT_BEARER,
          assertion: subjectToken,
          requested_token_use: 'on_behalf_of'
        }
      : {
          grant_type: GRANT_TOKEN_EXCHANGE,
          subject_token: subjectToken,
          subject_token_type: TOKEN_TYPE_ACCESS_TOKEN,
          requested_token_type: TOKEN_TYPE_ACCESS_TOKEN,
          ...(settings.audience ? { audience: settings.audience } : {})
        };
  if (scope) params.scope = scope;
  params.client_id = settings.clientId;
  params.client_secret = clientSecret;
  return params;
}

/**
 * Exchange the login access token for an iFinder token.
 * @returns {Promise<{accessToken: string, expiresAtMs: number|null, raw: Object}>}
 */
async function exchange(settings, subjectToken, scope) {
  if (settings.grantType === TOKEN_EXCHANGE_GRANT_TYPES.ENTRA_OBO && !scope) {
    throw configurationError(
      'The Entra On-Behalf-Of grant needs a scope (for example "api://<ifinder-app-id>/.default"). Set it in the scope map.'
    );
  }
  if (!settings.clientId) {
    throw configurationError(
      'The OIDC provider used for the iFinder token exchange has no client ID.'
    );
  }
  const clientSecret = resolveClientSecret(settings.clientSecretRef);
  const { response, data } = await postForm(
    settings.tokenURL,
    buildExchangeParams(settings, subjectToken, scope, clientSecret)
  );
  if (!response.ok || !data.access_token) {
    const providerCode = typeof data.error === 'string' ? data.error : undefined;
    const reason = data.error_description || providerCode || response.statusText || 'no token';
    throw errorWithCode(
      `${settings.displayName} refused the iFinder token exchange (HTTP ${response.status}): ${reason}`,
      IFINDER_AUTH_ERROR_CODES.EXCHANGE_FAILED,
      { providerCode, httpStatus: response.status }
    );
  }
  const lifetime = lifetimeSeconds(data.expires_in, data.access_token);
  return {
    accessToken: data.access_token,
    expiresAtMs: lifetime ? Date.now() + lifetime * 1000 : null,
    raw: data
  };
}

/**
 * Exchange for `user` and `scope`, retrying once with a refreshed login token
 * when the provider rejected the subject token (revoked or expired early).
 */
async function exchangeForUser(user, settings, scope) {
  const subjectToken = await getLoginAccessToken(user, settings);
  try {
    return await exchange(settings, subjectToken, scope);
  } catch (error) {
    if (!SUBJECT_TOKEN_REJECTED.has(error.providerCode)) throw error;
    logger.info('Subject token rejected by the exchange; refreshing the sign-in once', {
      component: COMPONENT,
      userId: user.id,
      providerCode: error.providerCode
    });
    const refreshed = await getLoginAccessToken(user, settings, {
      staleAccessToken: subjectToken
    });
    return exchange(settings, refreshed, scope);
  }
}

function assertAuthenticated(user) {
  if (!user || !user.id || user.id === 'anonymous') {
    throw new Error('iFinder JWT requires authenticated user');
  }
}

/**
 * Run the exchange without the cache and return the raw result (diagnostics).
 * @param {Object} user
 * @param {{scope?: string}} [options]
 * @returns {Promise<{token: string, scope: string, requestedScope: string, settings: Object, response: Object}>}
 */
export async function exchangeForDiagnostics(user, options = {}) {
  assertAuthenticated(user);
  const settings = resolveExchangeSettings();
  const requestedScope = options.scope || settings.defaultScope || 'fi_index_read';
  const scope = mapScope(requestedScope, settings);
  const result = await exchangeForUser(user, settings, scope);
  const { access_token: _token, refresh_token: _refresh, ...response } = result.raw;
  return { token: result.accessToken, scope, requestedScope, settings, response };
}

/**
 * The exchanged token for `user` and `scope`, from the cache when it is still
 * good for more than a minute.
 * @returns {Promise<string>}
 */
async function getExchangedToken(user, options, platform) {
  assertAuthenticated(user);
  const settings = resolveExchangeSettings(platform);
  const requestedScope = options.scope || settings.defaultScope || 'fi_index_read';
  const scope = mapScope(requestedScope, settings);
  const key = cacheKey(user.id, settings.audience, scope);

  const now = Date.now();
  const cached = exchangedTokens.get(key);
  if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > now) {
    return cached.token;
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const generation = cacheGeneration;
  const promise = exchangeForUser(user, settings, scope)
    .then(result => {
      if (result.expiresAtMs && generation === cacheGeneration) {
        pruneExpired(Date.now());
        exchangedTokens.set(key, {
          token: result.accessToken,
          expiresAtMs: result.expiresAtMs,
          userId: String(user.id)
        });
      }
      return result.accessToken;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * The `Authorization` header value for a call to iFinder or iAssistant.
 * @param {Object} user - Authenticated user (session, API key or task owner)
 * @param {{scope?: string}} [options] - iHub-side scope, e.g. `fa_iassistant`
 * @returns {Promise<string>} `Bearer <token>`
 */
export async function getAuthorizationHeader(user, options = {}) {
  const platform = configCache.getPlatform() || {};
  if (getAuthMode(getIFinderConfig()) === IFINDER_AUTH_MODES.IHUB_SIGNED) {
    return getIFinderAuthorizationHeader(user, options);
  }
  return `Bearer ${await getExchangedToken(user, options, platform)}`;
}

export default {
  getAuthorizationHeader,
  getAuthMode,
  getExchangeProviderName,
  shouldStoreLoginTokens,
  storeLoginTokens,
  deleteLoginTokens,
  getLoginTokenStatus,
  clearExchangedTokenCache,
  exchangeForDiagnostics
};
