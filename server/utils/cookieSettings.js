import configCache from '../configCache.js';
import logger from './logger.js';

/**
 * Get the secure flag value for cookies based on platform configuration and request protocol
 * @param {Object} req - Express request object (optional for backward compatibility)
 * @returns {boolean} Whether cookies should use the secure flag
 */
export function getCookieSecureFlag(req) {
  try {
    const platform = configCache.getPlatform() || {};
    const cookieSettings = platform.cookieSettings || {};

    // If disableSecure is explicitly set to true, disable the secure flag
    // This is an expert setting for customers running without SSL internally
    if (cookieSettings.disableSecure === true) {
      logger.warn(
        'Cookie secure flag is disabled - this should only be used in non-SSL environments',
        { component: 'CookieSettings' }
      );
      return false;
    }

    // If USE_HTTPS environment variable is set, use HTTPS
    // This is set to 'true' when running behind a reverse proxy with SSL or using native HTTPS
    if (process.env.USE_HTTPS === 'true') {
      return true;
    }

    // Detect protocol from actual request if available
    if (req) {
      // Check X-Forwarded-Proto header first (for reverse proxy scenarios)
      const forwardedProto = req.get('x-forwarded-proto');
      if (forwardedProto) {
        return forwardedProto === 'https';
      }

      // Check req.protocol (set by Express based on connection)
      if (req.protocol) {
        return req.protocol === 'https';
      }

      // Check req.secure (Express sets this based on protocol)
      if (req.secure !== undefined) {
        return req.secure;
      }
    }

    // Default to false (HTTP) if we can't detect the protocol
    return false;
  } catch (error) {
    logger.error('Error reading cookie settings, defaulting to HTTP (secure=false)', {
      component: 'CookieSettings',
      error
    });
    // Fail safe: if we can't read config, default to insecure (works with HTTP)
    // This ensures fresh installations work out of the box on HTTP
    return false;
  }
}

/**
 * Get standard cookie options for authentication tokens
 * @param {number} maxAge - Maximum age in milliseconds
 * @param {Object} req - Express request object (optional for backward compatibility)
 * @returns {object} Cookie options object
 */
export function getAuthCookieOptions(maxAge, req) {
  return {
    httpOnly: true,
    secure: getCookieSecureFlag(req),
    sameSite: 'lax',
    maxAge: maxAge
  };
}

/**
 * Get cookie options for clearing authentication tokens
 * @param {Object} req - Express request object (optional for backward compatibility)
 * @returns {object} Cookie options object for clearing cookies
 */
export function getClearAuthCookieOptions(req) {
  return {
    httpOnly: true,
    secure: getCookieSecureFlag(req),
    sameSite: 'lax'
  };
}
