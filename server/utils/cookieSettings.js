import configCache from '../configCache.js';
import logger from './logger.js';

/**
 * Get the secure flag value for cookies based on platform configuration
 * @returns {boolean} Whether cookies should use the secure flag
 */
export function getCookieSecureFlag() {
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

    // Check USE_HTTPS environment variable to determine if we're using HTTPS
    // This is set to 'true' when running behind a reverse proxy with SSL or using native HTTPS
    // If not set or set to anything other than 'true', assume HTTP (even in production)
    return process.env.USE_HTTPS === 'true';
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
 * @returns {object} Cookie options object
 */
export function getAuthCookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: getCookieSecureFlag(),
    sameSite: 'lax',
    maxAge: maxAge
  };
}

/**
 * Get cookie options for clearing authentication tokens
 * @returns {object} Cookie options object for clearing cookies
 */
export function getClearAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: getCookieSecureFlag(),
    sameSite: 'lax'
  };
}
