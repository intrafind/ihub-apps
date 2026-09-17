import crypto from 'crypto';
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
   * Whether unsanitized raw payloads (raw tokens, full user-info claims) may be
   * logged. Guarded by both the debug toggle and the explicit, security-gated
   * `includeRawData` flag (default false).
   */
  isRawDataEnabled(provider = null) {
    if (!this.isDebugEnabled(provider)) return false;
    return this.getDebugConfig(provider).includeRawData === true;
  }

  /**
   * Log authentication event.
   *
   * Auth debug is an explicit, self-contained opt-in — when it is enabled the
   * admin wants to see these traces. Winston's global `logging.level` (default
   * `info`) would otherwise swallow anything emitted at `debug`, forcing admins
   * to flip a second, separate switch. To make the single toggle sufficient we
   * emit informational traces at `info`; genuine warnings/errors keep their
   * severity so they still surface in production logs.
   */
  log(provider, level, event, data = {}, sessionId = null) {
    if (!this.isDebugEnabled(provider)) return;

    const config = this.getDebugConfig(provider);
    const sanitizedData = this.sanitizeData(data, config);

    const logEntry = {
      authDebug: true,
      provider,
      event,
      sessionId,
      ...sanitizedData
    };

    // Map non-error/warn levels up to `info` so they clear the default global
    // log level without the admin also having to lower `logging.level`.
    const effectiveLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    logger[effectiveLevel](event, { component: 'AuthService', ...logEntry });
  }

  /**
   * Sanitize sensitive data
   */
  sanitizeData(data, config = {}) {
    if (!data || typeof data !== 'object') return data;

    // When the admin has explicitly opted into raw data, bypass service-level
    // masking so the actual claims/tokens are visible for troubleshooting. The
    // core logger (utils/logger.js) still redacts known-sensitive keys as a
    // defense-in-depth safety net, so this stays a deliberate, bounded risk.
    if (config.includeRawData === true) return { ...data };

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
    return `session_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  }
}

// Create singleton instance
const authDebugService = new AuthDebugService();

export default authDebugService;
