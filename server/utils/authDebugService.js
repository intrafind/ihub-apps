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
    const timestamp = new Date().toISOString();
    const logEntry = {
      id: this.generateLogId(),
      timestamp,
      provider,
      level,
      event,
      sessionId: sessionId || this.generateSessionId(),
      data: this.sanitizeData(data, config),
      raw: config.includeRawData ? data : undefined
    };

    // Add to logs
    this.debugLogs.unshift(logEntry);

    // Enforce max entries
    if (this.debugLogs.length > this.maxEntries) {
      this.debugLogs = this.debugLogs.slice(0, this.maxEntries);
    }

    // Group by session
    if (logEntry.sessionId) {
      if (!this.sessionLogs.has(logEntry.sessionId)) {
        this.sessionLogs.set(logEntry.sessionId, []);
      }
      this.sessionLogs.get(logEntry.sessionId).unshift(logEntry);
    }

    // Emit event for any listeners (without real-time streaming)
    this.emit('log', logEntry);

    // Console logging if enabled
    if (config.consoleLogging) {
      console.log(`[AuthDebug:${provider}:${level}] ${event}`, logEntry.data);
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
   * Get debug logs with optional filtering
   */
  getLogs(filters = {}) {
    let logs = [...this.debugLogs];

    // Filter by provider
    if (filters.provider) {
      logs = logs.filter(log => log.provider === filters.provider);
    }

    // Filter by level
    if (filters.level) {
      logs = logs.filter(log => log.level === filters.level);
    }

    // Filter by event
    if (filters.event) {
      logs = logs.filter(log => log.event.includes(filters.event));
    }

    // Filter by session
    if (filters.sessionId) {
      logs = logs.filter(log => log.sessionId === filters.sessionId);
    }

    // Filter by time range
    if (filters.since) {
      const sinceDate = new Date(filters.since);
      logs = logs.filter(log => new Date(log.timestamp) >= sinceDate);
    }

    if (filters.until) {
      const untilDate = new Date(filters.until);
      logs = logs.filter(log => new Date(log.timestamp) <= untilDate);
    }

    // Limit results
    const limit = filters.limit || 100;
    return logs.slice(0, limit);
  }

  /**
   * Get logs for a specific session
   */
  getSessionLogs(sessionId) {
    return this.sessionLogs.get(sessionId) || [];
  }

  /**
   * Get debug statistics
   */
  getStats() {
    const stats = {
      totalLogs: this.debugLogs.length,
      providers: {},
      levels: {},
      sessions: this.sessionLogs.size,
      oldestLog: null,
      newestLog: null
    };

    if (this.debugLogs.length > 0) {
      stats.newestLog = this.debugLogs[0].timestamp;
      stats.oldestLog = this.debugLogs[this.debugLogs.length - 1].timestamp;

      // Count by provider and level
      this.debugLogs.forEach(log => {
        stats.providers[log.provider] = (stats.providers[log.provider] || 0) + 1;
        stats.levels[log.level] = (stats.levels[log.level] || 0) + 1;
      });
    }

    return stats;
  }

  /**
   * Clear all logs
   */
  clearLogs() {
    this.debugLogs = [];
    this.sessionLogs.clear();
    this.emit('cleared');
  }

  /**
   * Export logs in different formats
   */
  exportLogs(format = 'json', filters = {}) {
    const logs = this.getLogs(filters);

    switch (format.toLowerCase()) {
      case 'json':
        return JSON.stringify(logs, null, 2);

      case 'csv':
        if (logs.length === 0) return 'timestamp,provider,level,event,sessionId,data\n';

        const header = 'timestamp,provider,level,event,sessionId,data\n';
        const rows = logs
          .map(log => {
            const data = JSON.stringify(log.data).replace(/"/g, '""');
            return `"${log.timestamp}","${log.provider}","${log.level}","${log.event}","${log.sessionId || ''}","${data}"`;
          })
          .join('\n');
        return header + rows;

      case 'text':
        return logs
          .map(log => {
            const sessionInfo = log.sessionId ? ` [${log.sessionId}]` : '';
            const dataStr = JSON.stringify(log.data, null, 2);
            return `${log.timestamp} [${log.provider}:${log.level}]${sessionInfo} ${log.event}\n${dataStr}\n---`;
          })
          .join('\n');

      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Cleanup old logs
   */
  cleanup() {
    const cutoffTime = Date.now() - this.retentionMs;
    const initialCount = this.debugLogs.length;

    this.debugLogs = this.debugLogs.filter(log => {
      return new Date(log.timestamp).getTime() >= cutoffTime;
    });

    // Clean up session logs
    for (const [sessionId, logs] of this.sessionLogs.entries()) {
      const filteredLogs = logs.filter(log => {
        return new Date(log.timestamp).getTime() >= cutoffTime;
      });

      if (filteredLogs.length === 0) {
        this.sessionLogs.delete(sessionId);
      } else {
        this.sessionLogs.set(sessionId, filteredLogs);
      }
    }

    const removedCount = initialCount - this.debugLogs.length;
    if (removedCount > 0) {
      console.log(`AuthDebugService: Cleaned up ${removedCount} old log entries`);
    }
  }

  /**
   * Generate unique log ID
   */
  generateLogId() {
    return `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate session ID
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Destroy the service
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.removeAllListeners();
    this.debugLogs = [];
    this.sessionLogs.clear();
  }
}

// Create singleton instance
const authDebugService = new AuthDebugService();

export default authDebugService;
