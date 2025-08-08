import rateLimit from 'express-rate-limit';

/**
 * Rate limiting middleware configuration for API protection
 * Creates two rate limiters: one for normal APIs and one for admin APIs
 */

/**
 * Normal API rate limiter - more relaxed for regular use
 * Allows 100 requests per 15 minutes per IP
 */
export const normalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip successful responses to avoid penalizing normal usage
  skipSuccessfulRequests: false,
  // Skip failed requests to prevent DoS amplification
  skipFailedRequests: true
});

/**
 * Admin API rate limiter - more restrictive for administrative endpoints
 * Allows 50 requests per 15 minutes per IP
 */
export const adminApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 50, // limit each IP to 50 requests per windowMs
  message: {
    error: 'Too many admin requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Don't skip any requests for admin endpoints
  skipSuccessfulRequests: false,
  skipFailedRequests: false
});