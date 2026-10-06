import rateLimit from 'express-rate-limit';
import { recordRateLimitHit } from '../telemetry/metrics.js';
import { ClusterRateLimitStore } from '../utils/clusterRateLimitStore.js';

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
 *   - `/api/auth/user`, the per-provider discovery endpoints
 *     (`/api/auth/oidc/providers`, `/api/auth/ldap/providers`,
 *     `/api/auth/ntlm/status`, `/api/auth/teams/client-config`) — read-only.
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
  '/oidc/providers',
  '/ldap/providers',
  '/ntlm/status',
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
 * Create a rate limiter with given configuration
 * @param {Object} config - Rate limiter configuration
 * @param {Object} defaults - Default configuration to merge with
 * @param {string} type - Type of rate limiter for error messages
 * @param {(req: import('express').Request) => boolean} [skip] - Predicate that
 *   exempts a request from this limiter entirely
 * @returns {Function} Express rate limiter middleware
 */
function createRateLimiter(
  config = {},
  defaults = {},
  type = 'API',
  skip = undefined,
  { shared = false } = {}
) {
  const finalConfig = { ...defaults, ...config };

  return rateLimit({
    ...(skip ? { skip } : {}),
    // Counted across all cluster workers, so the limit means what it says.
    ...(shared ? { store: new ClusterRateLimitStore(type) } : {}),
    windowMs: finalConfig.windowMs || 1 * 60 * 1000, // 1 minute default
    limit: finalConfig.limit || 500, // 500 requests default
    message: finalConfig.message || {
      error: `Too many ${type.toLowerCase()} requests from this IP, please try again later.`,
      retryAfter: `${Math.ceil((finalConfig.windowMs || 1 * 60 * 1000) / 60000)} minutes`
    },
    standardHeaders: finalConfig.standardHeaders !== undefined ? finalConfig.standardHeaders : true,
    legacyHeaders: finalConfig.legacyHeaders !== undefined ? finalConfig.legacyHeaders : false,
    skipSuccessfulRequests:
      finalConfig.skipSuccessfulRequests !== undefined ? finalConfig.skipSuccessfulRequests : false,
    skipFailedRequests:
      finalConfig.skipFailedRequests !== undefined ? finalConfig.skipFailedRequests : false,
    // Telemetry hook fires once per IP per window when the limit is exceeded.
    // We label by the limiter's `type` (e.g. 'API', 'Admin API') because the
    // express request path would explode label cardinality.
    handler: (req, res, _next, options) => {
      try {
        recordRateLimitHit('http', String(type).toLowerCase());
      } catch {
        // never break the request because of a metrics failure
      }
      res.status(options.statusCode).send(options.message);
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
  'inferenceApi'
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
  inferenceApi: { limit: 500, windowMs: 1 * 60 * 1000 }
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
    adminApiLimiter: createRateLimiter(configs.adminApi, {}, 'admin API'),
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
