import rateLimit from 'express-rate-limit';

/**
 * Rate limiting middleware configuration for API protection
 * Creates configurable rate limiters based on platform configuration
 */

/**
 * Create a rate limiter with given configuration
 * @param {Object} config - Rate limiter configuration
 * @param {Object} defaults - Default configuration to merge with
 * @param {string} type - Type of rate limiter for error messages
 * @returns {Function} Express rate limiter middleware
 */
function createRateLimiter(config = {}, defaults = {}, type = 'API') {
  const finalConfig = { ...defaults, ...config };

  return rateLimit({
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
      finalConfig.skipFailedRequests !== undefined ? finalConfig.skipFailedRequests : false
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

  return {
    adminApiLimiter: createRateLimiter(adminApiConfig, {}, 'admin API'),
    publicApiLimiter: createRateLimiter(publicApiConfig, {}, 'public API'),
    authApiLimiter: createRateLimiter(authApiConfig, {}, 'authentication'),
    inferenceApiLimiter: createRateLimiter(inferenceApiConfig, {}, 'inference API')
  };
}
