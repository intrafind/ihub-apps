/**
 * Configurable logger for LLM SDK
 */

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4
};

export class Logger {
  constructor(options = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.prefix = options.prefix ?? '[LLM-SDK]';
    this.timestamp = options.timestamp ?? true;
    this.colors = options.colors ?? true;
    this.output = options.output ?? console;
  }

  /**
   * Check if level should be logged
   * @param {number} level - Log level to check
   * @returns {boolean} Whether to log
   */
  shouldLog(level) {
    return level >= this.level;
  }

  /**
   * Format log message with timestamp and prefix
   * @param {string} level - Log level string
   * @param {Array} args - Log arguments
   * @returns {Array} Formatted arguments
   */
  formatMessage(level, args) {
    const parts = [];
    
    if (this.timestamp) {
      parts.push(new Date().toISOString());
    }
    
    if (this.prefix) {
      parts.push(this.prefix);
    }
    
    parts.push(`[${level}]`);
    
    return [...parts, ...args];
  }

  /**
   * Apply colors to log message (if enabled)
   * @param {string} level - Log level
   * @param {Array} args - Message arguments
   * @returns {Array} Colored arguments (if colors enabled)
   */
  applyColors(level, args) {
    if (!this.colors || typeof process === 'undefined' || !process.stdout.isTTY) {
      return args;
    }

    const colors = {
      DEBUG: '\x1b[36m', // Cyan
      INFO: '\x1b[32m',  // Green
      WARN: '\x1b[33m',  // Yellow
      ERROR: '\x1b[31m'  // Red
    };

    const reset = '\x1b[0m';
    const color = colors[level] || '';

    if (color && args.length > 0) {
      args[0] = `${color}${args[0]}${reset}`;
    }

    return args;
  }

  /**
   * Log debug message
   * @param {...any} args - Arguments to log
   */
  debug(...args) {
    if (!this.shouldLog(LogLevel.DEBUG)) return;
    
    const formatted = this.formatMessage('DEBUG', args);
    const colored = this.applyColors('DEBUG', formatted);
    this.output.debug(...colored);
  }

  /**
   * Log info message
   * @param {...any} args - Arguments to log
   */
  info(...args) {
    if (!this.shouldLog(LogLevel.INFO)) return;
    
    const formatted = this.formatMessage('INFO', args);
    const colored = this.applyColors('INFO', formatted);
    this.output.info(...colored);
  }

  /**
   * Log warning message
   * @param {...any} args - Arguments to log
   */
  warn(...args) {
    if (!this.shouldLog(LogLevel.WARN)) return;
    
    const formatted = this.formatMessage('WARN', args);
    const colored = this.applyColors('WARN', formatted);
    this.output.warn(...colored);
  }

  /**
   * Log error message
   * @param {...any} args - Arguments to log
   */
  error(...args) {
    if (!this.shouldLog(LogLevel.ERROR)) return;
    
    const formatted = this.formatMessage('ERROR', args);
    const colored = this.applyColors('ERROR', formatted);
    this.output.error(...colored);
  }

  /**
   * Create child logger with additional prefix
   * @param {string} childPrefix - Additional prefix for child logger
   * @param {Object} options - Override options
   * @returns {Logger} Child logger instance
   */
  child(childPrefix, options = {}) {
    return new Logger({
      level: this.level,
      prefix: `${this.prefix} ${childPrefix}`,
      timestamp: this.timestamp,
      colors: this.colors,
      output: this.output,
      ...options
    });
  }

  /**
   * Set log level
   * @param {number} level - New log level
   */
  setLevel(level) {
    this.level = level;
  }

  /**
   * Enable or disable colors
   * @param {boolean} enabled - Whether to enable colors
   */
  setColors(enabled) {
    this.colors = enabled;
  }

  /**
   * Log performance timing
   * @param {string} operation - Operation name
   * @param {number} startTime - Start time from performance.now()
   * @param {Object} metadata - Additional metadata
   */
  timing(operation, startTime, metadata = {}) {
    if (!this.shouldLog(LogLevel.DEBUG)) return;
    
    const duration = performance.now() - startTime;
    this.debug(`Performance: ${operation} took ${duration.toFixed(2)}ms`, metadata);
  }

  /**
   * Log with structured data
   * @param {string} level - Log level ('debug', 'info', 'warn', 'error')
   * @param {string} message - Main message
   * @param {Object} data - Structured data to log
   */
  structured(level, message, data = {}) {
    const logMethod = this[level.toLowerCase()];
    if (!logMethod || !this.shouldLog(LogLevel[level.toUpperCase()])) return;

    logMethod.call(this, message, {
      timestamp: new Date().toISOString(),
      ...data
    });
  }

  /**
   * Create a timer for measuring operation duration
   * @param {string} operation - Operation name
   * @returns {Function} Timer function that logs duration when called
   */
  timer(operation) {
    const startTime = performance.now();
    return (metadata = {}) => {
      this.timing(operation, startTime, metadata);
    };
  }
}

/**
 * Create logger instance with environment-based configuration
 * @param {Object} options - Logger options
 * @returns {Logger} Configured logger instance
 */
export function createLogger(options = {}) {
  // Default configuration based on environment
  const defaults = {
    level: process.env.LOG_LEVEL ? 
      LogLevel[process.env.LOG_LEVEL.toUpperCase()] ?? LogLevel.INFO : 
      LogLevel.INFO,
    colors: process.env.NO_COLOR ? false : true,
    timestamp: process.env.LOG_TIMESTAMP !== 'false'
  };

  return new Logger({ ...defaults, ...options });
}

// Default logger instance
export const defaultLogger = createLogger();