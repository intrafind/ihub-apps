import winston from 'winston';

// Default log level and format (fallback if not configured)
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_LOG_FORMAT = 'json';

// JSON format for structured logging
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Custom format for text/console output with colors
const textFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// File format without colors (text or JSON based on config)
const fileTextFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Store reference to configCache (set later to avoid circular dependency)
let configCacheRef = null;

/**
 * Set configCache reference (called after configCache is initialized)
 * @param {Object} configCache - The configCache module
 */
export function setConfigCache(configCache) {
  configCacheRef = configCache;
}

/**
 * Get the current log level from platform configuration
 * @returns {string} Current log level
 */
function getLogLevel() {
  try {
    // Only try to get from config if configCache has been set
    if (configCacheRef) {
      const platformConfig = configCacheRef.get('platform');
      return platformConfig?.logging?.level || DEFAULT_LOG_LEVEL;
    }
    return DEFAULT_LOG_LEVEL;
  } catch (error) {
    // If config is not yet loaded, use default
    return DEFAULT_LOG_LEVEL;
  }
}

/**
 * Get the current log format from platform configuration
 * @returns {string} Current log format ('json' or 'text')
 */
function getLogFormat() {
  try {
    // Only try to get from config if configCache has been set
    if (configCacheRef) {
      const platformConfig = configCacheRef.get('platform');
      return platformConfig?.logging?.format || DEFAULT_LOG_FORMAT;
    }
    return DEFAULT_LOG_FORMAT;
  } catch (error) {
    // If config is not yet loaded, use default
    return DEFAULT_LOG_FORMAT;
  }
}

/**
 * Create winston logger instance
 */
function createLogger() {
  const format = getLogFormat();
  const consoleFormat = format === 'json' ? jsonFormat : textFormat;

  const logger = winston.createLogger({
    level: getLogLevel(),
    levels: winston.config.npm.levels,
    transports: [
      new winston.transports.Console({
        format: consoleFormat
      })
    ]
  });

  // Add file transport if file logging is enabled
  try {
    if (configCacheRef) {
      const platformConfig = configCacheRef.get('platform');
      if (platformConfig?.logging?.file?.enabled) {
        const logFile = platformConfig.logging.file.path || 'logs/app.log';
        const fileFormat = format === 'json' ? jsonFormat : fileTextFormat;
        logger.add(
          new winston.transports.File({
            filename: logFile,
            format: fileFormat,
            maxsize: platformConfig.logging.file.maxSize || 10485760, // 10MB default
            maxFiles: platformConfig.logging.file.maxFiles || 5
          })
        );
      }
    }
  } catch (error) {
    // Silently ignore errors during logger setup
  }

  return logger;
}

// Create the logger instance
let logger = createLogger();

/**
 * Update the logger's log level dynamically
 * @param {string} newLevel - New log level (error, warn, info, http, verbose, debug, silly)
 */
export function setLogLevel(newLevel) {
  logger.level = newLevel;
}

/**
 * Reconfigure the logger (e.g., when config changes)
 */
export function reconfigureLogger() {
  logger = createLogger();
}

/**
 * Get current log level
 * @returns {string} Current log level
 */
export function getLogLevelInfo() {
  return {
    current: logger.level,
    available: Object.keys(winston.config.npm.levels)
  };
}

// Export logger methods for easy use
export default {
  error: (...args) => logger.error(...args),
  warn: (...args) => logger.warn(...args),
  info: (...args) => logger.info(...args),
  http: (...args) => logger.http(...args),
  verbose: (...args) => logger.verbose(...args),
  debug: (...args) => logger.debug(...args),
  silly: (...args) => logger.silly(...args),

  // Alias for compatibility
  log: (...args) => logger.info(...args),
  trace: (...args) => logger.debug(...args),

  // Utility functions
  setLogLevel,
  reconfigureLogger,
  getLogLevelInfo,
  setConfigCache
};
