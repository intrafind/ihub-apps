// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { recordRateLimitHit } from '../telemetry/metrics.js';
import { ClusterRateLimitStore } from '../utils/clusterRateLimitStore.js';

import { ServiceError } from '../utils/ServiceError.js';
/**
 * Rate limiting middleware configuration for API protection
 * Creates configurable rate limiters based on platform configuration
 */

/**
 * Read-only endpoints below `/api/auth` that must NOT be governed by the strict
 * credential limiter.
 *
 * The auth limiter exists to slow down password guessing, so it is deliberately
 * tight: 30 requests / 15 minutes in the shipped `platform.json`, and 50 / 15
 * minutes from the code fallback below when `rateLimit.authApi` is absent
 * entirely. Applying it to the whole
 * `/api/auth` namespace also throttles endpoints that carry no credentials and
 * are polled as a matter of course:
 *
 *   - `/api/auth/status` — fetched on every SPA boot and on every 401 recovery,
 *     and commonly used as the container liveness/readiness probe.
 *   - `/api/auth/user` and `/api/auth/teams/client-config` — read-only.
 *   - `/api/auth/oidc/:provider/callback` — the SSO redirect target. One
 *     exhausted window here locks every user out of logging in.
 *   - `/api/auth/logout` and `/api/auth/oidc-logout` — must always be able to
 *     clear a session. Logging out of an OIDC deployment is a two-request flow
 *     (the POST clears iHub's cookie, the GET redirects to the provider's
 *     end_session_endpoint); throttling the second half strands the user
 *     logged out of iHub but still signed in at the provider, which is the
 *     exact failure RP-Initiated Logout exists to prevent.
 *
 * Behind two proxy hops `req.ip` resolves to the inner proxy for every caller
 * (see `trustProxy` in platform.json), so all users share a single counter and
 * a busy afternoon — or one OAuth/MCP handshake — takes the whole deployment's
 * status endpoint down for the rest of the window. These paths stay covered by
 * the public API limiter, which is generous but still bounded.
 *
 * Paths are matched mount-relative (the limiter is mounted on `/api/auth`), so
 * they hold under subpath deployments too.
 */
const READ_ONLY_AUTH_PATHS = new Set([
  '/status',
  '/user',
  '/logout',
  // Not covered by the `/oidc/` prefix rule below - that requires a slash.
  '/oidc-logout',
  '/teams/client-config'
]);

/**
 * True when the request targets a read-only/never-throttle auth endpoint.
 * Exported for tests.
 *
 * @param {import('express').Request} req - Request, as seen by middleware
 *   mounted on `/api/auth` (so `req.path` is mount-relative, e.g. `/status`).
 * @returns {boolean}
 */
export function isReadOnlyAuthRequest(req) {
  const path = req.path || '';
  // Trailing slashes are equivalent for routing; normalise before matching.
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (READ_ONLY_AUTH_PATHS.has(normalized)) return true;
  // OIDC sign-in redirect + callback: /oidc/<provider> and /oidc/<provider>/callback.
  // GET only — the POST variants (local/ldap/ntlm login) must stay throttled.
  if (req.method === 'GET' && normalized.startsWith('/oidc/')) return true;
  return false;
}

/**
 * Rate-limit key of the admin API limiter: one bucket per caller instead of
 * one per address.
 *
 * Admins behind one corporate NAT address or reverse proxy share `req.ip`, so
 * counting per address let one busy admin page (which fires many requests on
 * load) spend the budget of every other admin. The limiter therefore runs after
 * the authentication chain and counts per identity:
 *
 *   - a signed-in user (local, LDAP, OIDC, proxy, NTLM, Teams, a personal API
 *     key, or an OAuth token issued on a user's behalf) → `user:<user id>`;
 *   - an OAuth client (client_credentials) or a static API key, whose
 *     `req.user.id` is the client id → `client:<client id>`;
 *   - no signed-in user (no `req.user`, or the anonymous principal) → the
 *     client address, `ip:<address>`. IPv6 addresses are reduced to their /56
 *     subnet by `ipKeyGenerator`, as the library's default key does, so one
 *     host cannot side-step the limit by rotating through its own addresses.
 *
 * The prefixes keep the three kinds apart, so a user id that looks like an
 * address never shares a bucket with that address.
 *
 * @param {import('express').Request} req - Request after authentication.
 * @returns {string} The bucket key.
 * @example
 * adminApiRateLimitKey({ user: { id: 'alice' }, ip: '10.0.0.1' }); // 'user:alice'
 * adminApiRateLimitKey({ user: null, ip: '10.0.0.1' }); // 'ip:10.0.0.1'
 */
export function adminApiRateLimitKey(req) {
  const user = req.user;
  if (user?.id && user.id !== 'anonymous') {
    return user.isOAuthClient ? `client:${user.id}` : `user:${user.id}`;
  }
  return `ip:${ipKeyGenerator(req.ip || '')}`;
}

/**
 * Whether a finished `/api/admin` request leaves the pre-authentication limiter's count again:
 * every request answered below 400, and every request of a signed-in user or API client, whatever
 * its status. What stays counted is a failed request without a signed-in caller, chiefly one the
 * authentication chain refused (a bad, expired or revoked token), which never reaches the per-user
 * admin limiter.
 *
 * @param {import('express').Request} req - The request, after it was answered.
 * @param {import('express').Response} res - Its response.
 * @returns {boolean} True when the request does not count.
 * @example
 * adminApiAuthenticatedOrSucceeded({ user: null }, { statusCode: 401 }); // false (counts)
 * adminApiAuthenticatedOrSucceeded({ user: { id: 'alice' } }, { statusCode: 404 }); // true
 */
export function adminApiAuthenticatedOrSucceeded(req, res) {
  if (res.statusCode < 400) return true;
  const user = req.user;
  return Boolean(user?.id && user.id !== 'anonymous');
}

/**
 * Create a rate limiter with given configuration
 * @param {Object} config - Rate limiter configuration
 * @param {Object} defaults - Default configuration to merge with
 * @param {string} type - Type of rate limiter for error messages
 * @param {(req: import('express').Request) => boolean} [skip] - Predicate that
 *   exempts a request from this limiter entirely
 * @param {Object} [options]
 * @param {boolean} [options.shared=false] - Count across all cluster workers.
 * @param {(req: import('express').Request) => string} [options.keyGenerator] -
 *   Bucket key; the library's per-address key when omitted.
 * @param {(req: import('express').Request, res: import('express').Response) => boolean}
 *   [options.requestWasSuccessful] - Which finished requests count as successful for
 *   `skipSuccessfulRequests` / `skipFailedRequests`; status below 400 when omitted.
 * @returns {Function} Express rate limiter middleware
 */
function createRateLimiter(
  config = {},
  defaults = {},
  type = 'API',
  skip = undefined,
  { shared = false, keyGenerator = undefined, requestWasSuccessful = undefined } = {}
) {
  const finalConfig = { ...defaults, ...config };

  return rateLimit({
    ...(skip ? { skip } : {}),
    ...(keyGenerator ? { keyGenerator } : {}),
    ...(requestWasSuccessful ? { requestWasSuccessful } : {}),
    // Counted across all cluster workers, so the limit means what it says.
    ...(shared ? { store: new ClusterRateLimitStore(type) } : {}),
    windowMs: finalConfig.windowMs || 1 * 60 * 1000, // 1 minute default
    limit: finalConfig.limit || 500, // 500 requests default
    message:
      finalConfig.message ||
      (keyGenerator
        ? `Too many ${type.toLowerCase()} requests, please try again later.`
        : `Too many ${type.toLowerCase()} requests from this IP, please try again later.`),
    standardHeaders: finalConfig.standardHeaders !== undefined ? finalConfig.standardHeaders : true,
    legacyHeaders: finalConfig.legacyHeaders !== undefined ? finalConfig.legacyHeaders : false,
    skipSuccessfulRequests:
      finalConfig.skipSuccessfulRequests !== undefined ? finalConfig.skipSuccessfulRequests : false,
    skipFailedRequests:
      finalConfig.skipFailedRequests !== undefined ? finalConfig.skipFailedRequests : false,
    // Telemetry hook fires once per IP per window when the limit is exceeded.
    // We label by the limiter's `type` (e.g. 'API', 'Admin API') because the
    // express request path would explode label cardinality.
    handler: (req, res, next, options) => {
      try {
        recordRateLimitHit('http', String(type).toLowerCase());
      } catch {
        // never break the request because of a metrics failure
      }
      // `Retry-After` is already set by the limiter, with the exact wait. A configured message
      // may still be a plain string or an object of an older configuration.
      const text =
        typeof options.message === 'string'
          ? options.message
          : (options.message?.error ?? options.message?.message);
      next(
        new ServiceError('RATE_LIMITED', text || 'Too many requests', {
          status: options.statusCode
        })
      );
    }
  });
}

/**
 * The limiters an admin can tune, in the order Admin → Security lists them.
 * Each one is a key of `rateLimit` in platform.json; `default` is the base the
 * others inherit from and is not a limiter of its own.
 */
export const RATE_LIMITER_KEYS = Object.freeze([
  'publicApi',
  'adminApi',
  'authApi',
  'oauthApi',
  'oauthTokenApi',
  'inferenceApi',
  'provenanceVerifyApi'
]);

/**
 * What each limiter falls back to when platform.json does not set a value,
 * layered over `rateLimit.default`.
 */
const LIMITER_FALLBACKS = Object.freeze({
  // Admin API configuration
  adminApi: { limit: 500, skipFailedRequests: false },
  // Public API configuration - same as default
  publicApi: {},
  // Auth API configuration - more restrictive for authentication
  authApi: { limit: 50, windowMs: 15 * 60 * 1000, skipFailedRequests: false },
  // OAuth API - every request under /api/oauth, browsers and servers alike.
  // Sized for real traffic: the consent screen is opened from browsers that
  // often share one NAT address, and a server-side client such as Microsoft
  // 365 Copilot exchanges and refreshes every one of its users' tokens from a
  // handful of addresses. Credential guessing is the token limiter's job.
  oauthApi: { limit: 300, windowMs: 60 * 1000, skipFailedRequests: false },
  // OAuth token API - the token and introspection endpoints, which check a
  // client secret with bcrypt on every call. Only failed requests count, so a
  // client that authenticates correctly is never slowed down, while guessing
  // secrets (and burning CPU on bcrypt doing it) stops after a few attempts.
  oauthTokenApi: {
    limit: 30,
    windowMs: 15 * 60 * 1000,
    skipSuccessfulRequests: true,
    skipFailedRequests: false
  },
  // Inference API configuration - balanced for AI inference
  inferenceApi: { limit: 500, windowMs: 1 * 60 * 1000 },
  // Provenance lookup (`POST /api/eu-ai-act/provenance/_verify`): a membership oracle for a
  // candidate text, so it gets its own, stricter budget per client.
  provenanceVerifyApi: { limit: 60, windowMs: 60 * 1000, skipFailedRequests: false }
});

/**
 * Resolve the settings every limiter runs with: built-in fallbacks, then
 * `rateLimit.default`, then the limiter's own section of platform.json.
 * Exported for the admin page, which shows both the saved settings and the
 * ones the server started with.
 *
 * @param {Object} platformConfig - Platform configuration object
 * @returns {Record<string, {windowMs: number, limit: number, standardHeaders: boolean,
 *   legacyHeaders: boolean, skipSuccessfulRequests: boolean, skipFailedRequests: boolean}>}
 */
export function resolveRateLimitConfigs(platformConfig = {}) {
  const rateLimitConfig = platformConfig?.rateLimit || {};

  // Default configuration that all rate limiters inherit from
  const defaultConfig = {
    windowMs: 1 * 60 * 1000, // 1 minute
    limit: 500, // 500 requests
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: true,
    ...rateLimitConfig.default
  };

  return Object.fromEntries(
    RATE_LIMITER_KEYS.map(key => [
      key,
      { ...defaultConfig, ...LIMITER_FALLBACKS[key], ...rateLimitConfig[key] }
    ])
  );
}

/**
 * Create all rate limiters based on platform configuration
 * @param {Object} platformConfig - Platform configuration object
 * @returns {Object} Object containing all rate limiters
 */
export function createRateLimiters(platformConfig = {}) {
  const configs = resolveRateLimitConfigs(platformConfig);

  return {
    // Counted per signed-in user or API client, per address only without a
    // sign-in. Mount it after the authentication chain (see setup.js).
    adminApiLimiter: createRateLimiter(configs.adminApi, {}, 'admin API', undefined, {
      keyGenerator: adminApiRateLimitKey
    }),
    // Mounted on /api/admin before the authentication chain, per address, with the admin API
    // budget. It counts only failed requests without a signed-in caller, so it bounds a flood of
    // refused tokens (which the auth chain answers before adminApiLimiter runs) without making
    // admins behind one address share a budget again.
    adminApiUnauthenticatedLimiter: createRateLimiter(
      { ...configs.adminApi, skipSuccessfulRequests: true, skipFailedRequests: false },
      {},
      'admin API',
      undefined,
      { requestWasSuccessful: adminApiAuthenticatedOrSucceeded }
    ),
    publicApiLimiter: createRateLimiter(configs.publicApi, {}, 'public API'),
    // Read-only auth endpoints skip the strict credential limiter; they are
    // still bounded by the public API limiter mounted on the same path.
    authApiLimiter: createRateLimiter(
      configs.authApi,
      {},
      'authentication',
      isReadOnlyAuthRequest,
      {
        shared: true
      }
    ),
    inferenceApiLimiter: createRateLimiter(configs.inferenceApi, {}, 'inference API'),
    oauthApiLimiter: createRateLimiter(configs.oauthApi, {}, 'OAuth API', undefined, {
      shared: true
    })
  };
}

/**
 * The limiter for the OAuth endpoints that check a client secret (`/token` and
 * `/introspect`). The routes mount it themselves (routes/oauth.js), one
 * instance for both, so a guess at either endpoint spends the same budget.
 *
 * @param {Object} platformConfig - Platform configuration object
 * @returns {Function} Express rate limiter middleware
 */
export function createOAuthTokenLimiter(platformConfig = {}) {
  const { oauthTokenApi } = resolveRateLimitConfigs(platformConfig);
  return createRateLimiter(oauthTokenApi, {}, 'OAuth token', undefined, { shared: true });
}

/**
 * The limiter of the provenance lookup. The route mounts it itself; the budget
 * is shared across cluster workers.
 *
 * @param {Object} platformConfig - Platform configuration object
 * @returns {Function} Express rate limiter middleware
 */
export function createProvenanceVerifyLimiter(platformConfig = {}) {
  const { provenanceVerifyApi } = resolveRateLimitConfigs(platformConfig);
  return createRateLimiter(provenanceVerifyApi, {}, 'provenance verify', undefined, {
    shared: true
  });
}
