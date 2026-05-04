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

    // Default behavior: use secure flag in production
    return process.env.NODE_ENV === 'production';
  } catch (error) {
    logger.error('Error reading cookie settings, defaulting to secure in production', {
      component: 'CookieSettings',
      error
    });
    // Fail safe: if we can't read config, default to secure in production
    return process.env.NODE_ENV === 'production';
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
