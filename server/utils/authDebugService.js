import configCache from '../configCache.js';
import { EventEmitter } from 'events';

/**
 * Centralized authentication debugging service
 * Provides secure logging and monitoring for authentication providers
 */
class AuthDebugService extends EventEmitter {
  constructor() {
    super();
    this.debugLogs = [];
    this.maxEntries = 1000;
    this.retentionMs = 24 * 60 * 60 * 1000; // 24 hours
    this.sessionLogs = new Map(); // Session-based log grouping

    // Start cleanup interval
    this.cleanupInterval = setInterval(
      () => {
        this.cleanup();
      },
      60 * 60 * 1000
    ); // Cleanup every hour
  }

  /**
   * Check if debug is enabled globally or for specific provider
   */
  isDebugEnabled(provider = null) {
    const platform = configCache.getPlatform() || {};
    const globalDebug = platform.authDebug?.enabled || false;

    if (!globalDebug) return false;

    if (provider) {
      const providerConfig = platform.authDebug?.providers?.[provider];
      return providerConfig?.enabled !== false; // Default to true if global debug is on
    }

    return true;
  }

  /**
   * Get debug configuration for a specific provider
   */
  getDebugConfig(provider = null) {
    const platform = configCache.getPlatform() || {};
    const globalConfig = platform.authDebug || {};

    if (provider) {
      const providerConfig = platform.authDebug?.providers?.[provider] || {};
      return {
        ...globalConfig,
        ...providerConfig
      };
    }

    return globalConfig;
  }

  /**
   * Log authentication debug event
   */
  log(provider, level, event, data, context = {}) {
    if (!this.isDebugEnabled(provider)) return;

    const config = this.getDebugConfig(provider);
    const sessionId = context.sessionId || 'unknown';

    // Sanitize data based on configuration
    const sanitizedData = this.sanitizeData(data, config);

    const logEntry = {
      id: this.generateLogId(),
      timestamp: new Date().toISOString(),
      provider,
      level,
      event,
      data: sanitizedData,
      sessionId,
      userId: context.userId,
      requestId: context.requestId,
      userAgent: context.userAgent,
      ip: context.ip
    };

    // Add to main log
    this.debugLogs.unshift(logEntry);
    if (this.debugLogs.length > this.maxEntries) {
      this.debugLogs.pop();
    }

    // Add to session-specific log
    if (!this.sessionLogs.has(sessionId)) {
      this.sessionLogs.set(sessionId, []);
    }
    this.sessionLogs.get(sessionId).unshift(logEntry);

    // Console logging with enhanced formatting
    const prefix = `🔐 [${provider.toUpperCase()}] [${level.toUpperCase()}] [${sessionId.slice(-8)}]`;
    console.log(`${prefix} ${event}:`, this.formatForConsole(sanitizedData));

    // Emit event for real-time monitoring
    this.emit('authDebugLog', logEntry);

    return logEntry.id;
  }

  /**
   * Sanitize sensitive data based on configuration
   */
  sanitizeData(data, config) {
    if (!data || typeof data !== 'object') return data;

    const sanitized = JSON.parse(JSON.stringify(data)); // Deep copy

    // Always remove these sensitive fields
    const alwaysRedact = ['password', 'clientSecret', 'client_secret', 'authorization'];
    alwaysRedact.forEach(field => {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    });

    // Token handling based on configuration
    const tokenFields = ['access_token', 'refresh_token', 'id_token', 'token', 'jwt'];
    if (!config.includeTokens) {
      tokenFields.forEach(field => {
        if (sanitized[field]) {
          sanitized[field] = this.maskToken(sanitized[field]);
        }
      });
    }

    // User info handling
    if (!config.includeUserInfo) {
      const userFields = ['email', 'name', 'given_name', 'family_name', 'preferred_username'];
      userFields.forEach(field => {
        if (sanitized[field]) {
          sanitized[field] = '[HIDDEN]';
        }
      });
    }

    // Headers handling
    if (sanitized.headers && !config.includeHeaders) {
      sanitized.headers = '[HIDDEN]';
    }

    return sanitized;
  }

  /**
   * Mask token showing first and last 4 characters
   */
  maskToken(token) {
    if (!token || typeof token !== 'string') return token;
    if (token.length < 10) return '***';
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  }

  /**
   * Format data for console output
   */
  formatForConsole(data) {
    if (typeof data === 'string') return data;
    if (typeof data === 'object') {
      return JSON.stringify(data, null, 2);
    }
    return String(data);
  }

  /**
   * Generate unique log ID
   */
  generateLogId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get debug logs with filtering and pagination
   */
  getDebugLogs(options = {}) {
    const {
      provider = null,
      level = null,
      sessionId = null,
      limit = 50,
      offset = 0,
      startTime = null,
      endTime = null
    } = options;

    let logs = [...this.debugLogs];

    // Apply filters
    if (provider) {
      logs = logs.filter(log => log.provider === provider);
    }

    if (level) {
      logs = logs.filter(log => log.level === level);
    }

    if (sessionId) {
      logs = logs.filter(log => log.sessionId === sessionId);
    }

    if (startTime) {
      logs = logs.filter(log => new Date(log.timestamp) >= new Date(startTime));
    }

    if (endTime) {
      logs = logs.filter(log => new Date(log.timestamp) <= new Date(endTime));
    }

    // Apply pagination
    const total = logs.length;
    const paginatedLogs = logs.slice(offset, offset + limit);

    return {
      logs: paginatedLogs,
      total,
      offset,
      limit,
      hasMore: offset + limit < total
    };
  }

  /**
   * Get logs for a specific session
   */
  getSessionLogs(sessionId, limit = 50) {
    const sessionLogs = this.sessionLogs.get(sessionId) || [];
    return sessionLogs.slice(0, limit);
  }

  /**
   * Get debug statistics
   */
  getDebugStats() {
    const stats = {
      totalLogs: this.debugLogs.length,
      activeSessions: this.sessionLogs.size,
      providerStats: {},
      levelStats: {},
      recentActivity: []
    };

    // Calculate provider and level statistics
    this.debugLogs.forEach(log => {
      // Provider stats
      if (!stats.providerStats[log.provider]) {
        stats.providerStats[log.provider] = 0;
      }
      stats.providerStats[log.provider]++;

      // Level stats
      if (!stats.levelStats[log.level]) {
        stats.levelStats[log.level] = 0;
      }
      stats.levelStats[log.level]++;
    });

    // Recent activity (last 10 logs)
    stats.recentActivity = this.debugLogs.slice(0, 10).map(log => ({
      timestamp: log.timestamp,
      provider: log.provider,
      level: log.level,
      event: log.event,
      sessionId: log.sessionId
    }));

    return stats;
  }

  /**
   * Clear debug logs
   */
  clearLogs(provider = null) {
    if (provider) {
      this.debugLogs = this.debugLogs.filter(log => log.provider !== provider);
      // Clean session logs
      this.sessionLogs.forEach((logs, sessionId) => {
        const filteredLogs = logs.filter(log => log.provider !== provider);
        if (filteredLogs.length === 0) {
          this.sessionLogs.delete(sessionId);
        } else {
          this.sessionLogs.set(sessionId, filteredLogs);
        }
      });
    } else {
      this.debugLogs = [];
      this.sessionLogs.clear();
    }

    this.emit('authDebugCleared', { provider });
  }

  /**
   * Cleanup old logs based on retention policy
   */
  cleanup() {
    const cutoffTime = Date.now() - this.retentionMs;
    const initialCount = this.debugLogs.length;

    // Remove old logs
    this.debugLogs = this.debugLogs.filter(log => {
      return new Date(log.timestamp).getTime() > cutoffTime;
    });

    // Clean session logs
    this.sessionLogs.forEach((logs, sessionId) => {
      const filteredLogs = logs.filter(log => {
        return new Date(log.timestamp).getTime() > cutoffTime;
      });

      if (filteredLogs.length === 0) {
        this.sessionLogs.delete(sessionId);
      } else {
        this.sessionLogs.set(sessionId, filteredLogs);
      }
    });

    const removedCount = initialCount - this.debugLogs.length;
    if (removedCount > 0) {
      console.log(`🔐 [AUTH-DEBUG] Cleaned up ${removedCount} old debug logs`);
    }
  }

  /**
   * Export logs in various formats
   */
  exportLogs(format = 'json', options = {}) {
    const logs = this.getDebugLogs(options).logs;

    switch (format) {
      case 'json':
        return JSON.stringify(logs, null, 2);

      case 'csv':
        if (logs.length === 0) return '';

        const headers = ['timestamp', 'provider', 'level', 'event', 'sessionId', 'userId', 'data'];
        const csvRows = [headers.join(',')];

        logs.forEach(log => {
          const row = [
            log.timestamp,
            log.provider,
            log.level,
            log.event,
            log.sessionId || '',
            log.userId || '',
            JSON.stringify(log.data).replace(/"/g, '""')
          ];
          csvRows.push(row.map(field => `"${field}"`).join(','));
        });

        return csvRows.join('\n');

      case 'text':
        return logs
          .map(log => {
            return `[${log.timestamp}] ${log.provider.toUpperCase()} ${log.level.toUpperCase()} ${log.event} (${log.sessionId})\n${JSON.stringify(log.data, null, 2)}\n`;
          })
          .join('\n---\n\n');

      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Destroy the service and clean up resources
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.debugLogs = [];
    this.sessionLogs.clear();
    this.removeAllListeners();
  }
}

// Export singleton instance
export default new AuthDebugService();
