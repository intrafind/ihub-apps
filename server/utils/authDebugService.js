import configCache from '../configCache.js';
import logger from './logger.js';

/**
 * Centralized authentication debugging service
 * Provides secure logging for authentication providers via Winston
 */
class AuthDebugService {
  /**
   * Check if debug is enabled globally or for specific provider
   */
  isDebugEnabled(provider = null) {
    const platform = configCache.getPlatform() || {};
    const globalDebug = platform.auth?.debug?.enabled || false;

    if (!globalDebug) return false;

    if (provider) {
      const providerConfig = platform.auth?.debug?.providers?.[provider];
      return providerConfig?.enabled !== false; // Default to true if global debug is on
    }

    return true;
  }

  /**
   * Get debug configuration for a specific provider
   */
  getDebugConfig(provider = null) {
    const platform = configCache.getPlatform() || {};
    const globalConfig = platform.auth?.debug || {};

    if (provider) {
      const providerConfig = platform.auth?.debug?.providers?.[provider] || {};
      return {
        ...globalConfig,
        ...providerConfig,
        enabled: this.isDebugEnabled(provider)
      };
    }

    return globalConfig;
  }

  /**
   * Log authentication event
   */
  log(provider, level, event, data = {}, sessionId = null) {
    if (!this.isDebugEnabled(provider)) return;

    const config = this.getDebugConfig(provider);
    const sanitizedData = this.sanitizeData(data, config);

    const logEntry = {
      provider,
      event,
      sessionId,
      ...sanitizedData
    };

    // Log via Winston based on level
    switch (level) {
      case 'error':
        logger.error(`[AuthDebug:${provider}] ${event}`, {
          component: 'AuthService',
          ...logEntry
        });
        break;
      case 'warn':
        logger.warn(`[AuthDebug:${provider}] ${event}`, { component: 'AuthService', ...logEntry });
        break;
      case 'info':
        logger.info(`[AuthDebug:${provider}] ${event}`, { component: 'AuthService', ...logEntry });
        break;
      case 'debug':
      default:
        logger.debug(`[AuthDebug:${provider}] ${event}`, {
          component: 'AuthService',
          ...logEntry
        });
        break;
    }
  }

  /**
   * Sanitize sensitive data
   */
  sanitizeData(data, config = {}) {
    if (!data || typeof data !== 'object') return data;

    const sanitized = { ...data };
    const maskTokens = config.maskTokens !== false; // Default to true
    const redactPasswords = config.redactPasswords !== false; // Default to true

    // Token masking
    if (maskTokens) {
      Object.keys(sanitized).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('key')) {
          if (typeof sanitized[key] === 'string' && sanitized[key].length > 8) {
            sanitized[key] = sanitized[key].substring(0, 8) + '***';
          }
        }
      });
    }

    // Password redaction
    if (redactPasswords) {
      Object.keys(sanitized).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes('password') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('credential')
        ) {
          sanitized[key] = '[REDACTED]';
        }
      });
    }

    return sanitized;
  }

  /**
   * Generate session ID for tracking auth flows
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Create singleton instance
const authDebugService = new AuthDebugService();

export default authDebugService;
