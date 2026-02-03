import winston from 'winston';

// Default log level and format (fallback if not configured)
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_LOG_FORMAT = 'json';

/**
 * Custom JSON formatter with fixed field order
 * Ensures consistent field ordering: component, level, timestamp, message, then other fields
 */
const orderedJsonFormat = winston.format.printf(info => {
  // Define the desired field order
  const orderedLog = {};

  // 1. Component (if present)
  if (info.component !== undefined) {
    orderedLog.component = info.component;
  }

  // 2. Log level
  orderedLog.level = info.level;

  // 3. Timestamp
  if (info.timestamp !== undefined) {
    orderedLog.timestamp = info.timestamp;
  }

  // 4. Message
  if (info.message !== undefined) {
    orderedLog.message = info.message;
  }

  // 5. Add all other fields (except the ones we've already added)
  const reservedFields = ['component', 'level', 'timestamp', 'message'];
  Object.keys(info).forEach(key => {
    if (
      !reservedFields.includes(key) &&
      key !== Symbol.for('level') &&
      key !== Symbol.for('message') &&
      key !== Symbol.for('splat')
    ) {
      orderedLog[key] = info[key];
    }
  });

  return JSON.stringify(orderedLog);
});

// JSON format for structured logging with fixed field order
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  orderedJsonFormat
);

// Custom format for text/console output with colors
const textFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, component, ...meta }) => {
    const componentTag = component ? `[${component}]` : '';
    let msg = `${timestamp} [${level}]${componentTag}: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// File format without colors (text or JSON based on config)
const fileTextFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, component, ...meta }) => {
    const componentTag = component ? `[${component}]` : '';
    let msg = `${timestamp} [${level}]${componentTag}: ${message}`;
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
  } catch {
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
  } catch {
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
  } catch {
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

/**
 * Helper function to extract component and metadata from arguments
 * Supports two patterns:
 * 1. logger.info('message', { component: 'MyComponent', ...otherMeta })
 * 2. logger.info({ component: 'MyComponent', message: 'my message', ...otherMeta })
 */
function processLogArgs(args) {
  // If first arg is an object with a message property, use it directly
  if (args.length === 1 && typeof args[0] === 'object' && args[0].message) {
    return args[0];
  }

  // If first arg is a string and second is an object, combine them
  if (args.length >= 2 && typeof args[0] === 'string' && typeof args[1] === 'object') {
    return { message: args[0], ...args[1] };
  }

  // If first arg is a string only, convert to object
  if (args.length === 1 && typeof args[0] === 'string') {
    return { message: args[0] };
  }

  // For backward compatibility with winston's multiple args
  // Convert to message with metadata
  const message = args[0];
  const meta = args.slice(1).reduce((acc, arg) => {
    if (typeof arg === 'object') {
      return { ...acc, ...arg };
    }
    return acc;
  }, {});

  if (typeof message === 'object') {
    return { ...message, ...meta };
  }

  return Object.keys(meta).length > 0 ? { message, ...meta } : { message };
}

// Export logger methods for easy use
export default {
  error: (...args) => {
    const logData = processLogArgs(args);
    logger.error(logData);
  },
  warn: (...args) => {
    const logData = processLogArgs(args);
    logger.warn(logData);
  },
  info: (...args) => {
    const logData = processLogArgs(args);
    logger.info(logData);
  },
  http: (...args) => {
    const logData = processLogArgs(args);
    logger.http(logData);
  },
  verbose: (...args) => {
    const logData = processLogArgs(args);
    logger.verbose(logData);
  },
  debug: (...args) => {
    const logData = processLogArgs(args);
    logger.debug(logData);
  },
  silly: (...args) => {
    const logData = processLogArgs(args);
    logger.silly(logData);
  },

  // Alias for compatibility
  log: (...args) => {
    const logData = processLogArgs(args);
    logger.info(logData);
  },
  trace: (...args) => {
    const logData = processLogArgs(args);
    logger.debug(logData);
  },

  // Utility functions
  setLogLevel,
  reconfigureLogger,
  getLogLevelInfo,
  setConfigCache
};
