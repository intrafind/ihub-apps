import rateLimit from 'express-rate-limit';
import { recordRateLimitHit } from '../telemetry/metrics.js';

/**
 * Rate limiting middleware configuration for API protection
 * Creates configurable rate limiters based on platform configuration
 */

/**
 * Read-only endpoints below `/api/auth` that must NOT be governed by the strict
 * credential limiter.
 *
 * The auth limiter exists to slow down password guessing, so it is deliberately
 * tight (30 requests / 15 minutes by default). Applying it to the whole
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
 *   - `/api/auth/logout` — must always be able to clear a session.
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
function createRateLimiter(config = {}, defaults = {}, type = 'API', skip = undefined) {
  const finalConfig = { ...defaults, ...config };

  return rateLimit({
    ...(skip ? { skip } : {}),
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
 * Create all rate limiters based on platform configuration
 * @param {Object} platformConfig - Platform configuration object
 * @returns {Object} Object containing all rate limiters
 */
export function createRateLimiters(platformConfig = {}) {
  const rateLimitConfig = platformConfig.rateLimit || {};

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

  // Admin API configuration - more restrictive by default
  const adminApiConfig = {
    ...defaultConfig,
    limit: 500, // More restrictive for admin endpoints
    skipFailedRequests: false, // Don't skip failed requests for admin endpoints
    ...rateLimitConfig.adminApi
  };

  // Public API configuration - same as default
  const publicApiConfig = {
    ...defaultConfig,
    ...rateLimitConfig.publicApi
  };

  // Auth API configuration - more restrictive for authentication
  const authApiConfig = {
    ...defaultConfig,
    limit: 50, // More restrictive for auth endpoints
    windowMs: 15 * 60 * 1000, // 15 minutes
    skipFailedRequests: false, // Don't skip failed requests for auth
    ...rateLimitConfig.authApi
  };

  // Inference API configuration - balanced for AI inference
  const inferenceApiConfig = {
    ...defaultConfig,
    limit: 500, // Moderate limit for inference
    windowMs: 1 * 60 * 1000, // 1 minute
    ...rateLimitConfig.inferenceApi
  };

  // OAuth API configuration - protect token/authorize endpoints from brute force
  const oauthApiConfig = {
    ...defaultConfig,
    limit: 50, // Stricter: 50 requests per 15 min for token endpoint
    windowMs: 15 * 60 * 1000,
    skipFailedRequests: false,
    ...rateLimitConfig.oauthApi
  };

  return {
    adminApiLimiter: createRateLimiter(adminApiConfig, {}, 'admin API'),
    publicApiLimiter: createRateLimiter(publicApiConfig, {}, 'public API'),
    // Read-only auth endpoints skip the strict credential limiter; they are
    // still bounded by the public API limiter mounted on the same path.
    authApiLimiter: createRateLimiter(authApiConfig, {}, 'authentication', isReadOnlyAuthRequest),
    inferenceApiLimiter: createRateLimiter(inferenceApiConfig, {}, 'inference API'),
    oauthApiLimiter: createRateLimiter(oauthApiConfig, {}, 'OAuth API')
  };
}
