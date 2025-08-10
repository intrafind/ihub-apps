import { Validator, providerConfigSchema } from '../utils/Validator.js';
import { ConfigurationError } from '../utils/ErrorHandler.js';
import { defaultLogger } from '../utils/Logger.js';

/**
 * Provider configuration management with environment variable support
 */
export class ProviderConfig {
  constructor(options = {}) {
    this.logger = options.logger || defaultLogger.child('ProviderConfig');
    this.configs = new Map();
    this.envPrefix = options.envPrefix || 'LLM_SDK';
    this.allowEnvOverrides = options.allowEnvOverrides !== false;
  }

  /**
   * Load provider configurations
   * @param {Object} providersConfig - Provider configurations object
   * @returns {void}
   */
  load(providersConfig) {
    if (!providersConfig || typeof providersConfig !== 'object') {
      throw new ConfigurationError(
        'Provider configurations must be an object',
        'providersConfig',
        null
      );
    }

    this.configs.clear();

    for (const [providerName, config] of Object.entries(providersConfig)) {
      try {
        const processedConfig = this.processProviderConfig(providerName, config);
        const validatedConfig = this.validateProviderConfig(processedConfig, providerName);

        this.configs.set(providerName, validatedConfig);
        this.logger.debug(`Loaded configuration for provider: ${providerName}`);
      } catch (error) {
        this.logger.error(`Failed to load configuration for provider ${providerName}:`, error);
        throw new ConfigurationError(
          `Failed to load configuration for provider '${providerName}': ${error.message}`,
          `providers.${providerName}`,
          config,
          error
        );
      }
    }

    this.logger.info(`Loaded configurations for ${this.configs.size} providers`);
  }

  /**
   * Process provider configuration with environment variable substitution
   * @param {string} providerName - Provider name
   * @param {Object} config - Raw configuration
   * @returns {Object} Processed configuration
   */
  processProviderConfig(providerName, config) {
    const processed = { ...config };

    // Process environment variables
    if (this.allowEnvOverrides) {
      processed.apiKey = this.getConfigValue(providerName, 'apiKey', processed.apiKey);

      processed.baseURL = this.getConfigValue(providerName, 'baseURL', processed.baseURL);

      processed.timeout = this.getConfigValue(providerName, 'timeout', processed.timeout, 'number');

      processed.retries = this.getConfigValue(providerName, 'retries', processed.retries, 'number');

      processed.defaultModel = this.getConfigValue(
        providerName,
        'defaultModel',
        processed.defaultModel
      );

      processed.maxTokens = this.getConfigValue(
        providerName,
        'maxTokens',
        processed.maxTokens,
        'number'
      );

      processed.temperature = this.getConfigValue(
        providerName,
        'temperature',
        processed.temperature,
        'number'
      );
    }

    // Process string interpolation for values like ${VAR_NAME}
    processed.apiKey = this.interpolateEnvVars(processed.apiKey);
    processed.baseURL = this.interpolateEnvVars(processed.baseURL);

    return processed;
  }

  /**
   * Get configuration value with environment variable override
   * @param {string} providerName - Provider name
   * @param {string} key - Configuration key
   * @param {*} defaultValue - Default value
   * @param {string} type - Value type for conversion
   * @returns {*} Configuration value
   */
  getConfigValue(providerName, key, defaultValue, type = 'string') {
    const envKeys = [
      `${this.envPrefix}_${providerName.toUpperCase()}_${key.toUpperCase()}`,
      `${this.envPrefix}_${key.toUpperCase()}`,
      `${providerName.toUpperCase()}_${key.toUpperCase()}`,
      key.toUpperCase()
    ];

    for (const envKey of envKeys) {
      const envValue = process.env[envKey];
      if (envValue !== undefined) {
        return this.convertValue(envValue, type);
      }
    }

    return defaultValue;
  }

  /**
   * Convert string value to specified type
   * @param {string} value - String value
   * @param {string} type - Target type
   * @returns {*} Converted value
   */
  convertValue(value, type) {
    switch (type) {
      case 'number':
        const num = Number(value);
        return isNaN(num) ? value : num;
      case 'boolean':
        return value.toLowerCase() === 'true';
      case 'json':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      default:
        return value;
    }
  }

  /**
   * Interpolate environment variables in string values
   * @param {string} value - Value with possible ${VAR} patterns
   * @returns {string} Interpolated value
   */
  interpolateEnvVars(value) {
    if (typeof value !== 'string') {
      return value;
    }

    return value.replace(/\${([^}]+)}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        this.logger.warn(`Environment variable not found: ${varName}`);
        return match; // Keep original if not found
      }
      return envValue;
    });
  }

  /**
   * Validate provider configuration
   * @param {Object} config - Configuration to validate
   * @param {string} providerName - Provider name
   * @returns {Object} Validated configuration
   */
  validateProviderConfig(config, providerName) {
    try {
      return Validator.validateProviderConfig(config, providerName);
    } catch (error) {
      throw new ConfigurationError(
        `Invalid configuration for provider '${providerName}': ${error.message}`,
        'config',
        config,
        error
      );
    }
  }

  /**
   * Get provider configuration
   * @param {string} providerName - Provider name
   * @returns {Object|null} Provider configuration or null if not found
   */
  getConfig(providerName) {
    return this.configs.get(providerName) || null;
  }

  /**
   * Get all provider configurations
   * @returns {Object} All configurations
   */
  getAllConfigs() {
    const result = {};
    for (const [name, config] of this.configs) {
      result[name] = config;
    }
    return result;
  }

  /**
   * Check if provider configuration exists
   * @param {string} providerName - Provider name
   * @returns {boolean} Whether configuration exists
   */
  hasConfig(providerName) {
    return this.configs.has(providerName);
  }

  /**
   * Add or update provider configuration
   * @param {string} providerName - Provider name
   * @param {Object} config - Provider configuration
   */
  setConfig(providerName, config) {
    const processedConfig = this.processProviderConfig(providerName, config);
    const validatedConfig = this.validateProviderConfig(processedConfig, providerName);

    this.configs.set(providerName, validatedConfig);
    this.logger.info(`Updated configuration for provider: ${providerName}`);
  }

  /**
   * Remove provider configuration
   * @param {string} providerName - Provider name
   * @returns {boolean} Whether configuration was removed
   */
  removeConfig(providerName) {
    const removed = this.configs.delete(providerName);
    if (removed) {
      this.logger.info(`Removed configuration for provider: ${providerName}`);
    }
    return removed;
  }

  /**
   * Get list of configured providers
   * @returns {Array<string>} Provider names
   */
  getProviders() {
    return Array.from(this.configs.keys());
  }

  /**
   * Validate all configurations
   * @returns {Object} Validation results
   */
  validateAll() {
    const results = {};

    for (const [providerName, config] of this.configs) {
      try {
        this.validateProviderConfig(config, providerName);
        results[providerName] = { valid: true };
      } catch (error) {
        results[providerName] = {
          valid: false,
          error: error.message
        };
      }
    }

    return results;
  }

  /**
   * Test API key format for all providers
   * @returns {Object} Test results
   */
  testApiKeys() {
    const results = {};

    for (const [providerName, config] of this.configs) {
      const isValid = Validator.validateApiKeyFormat(config.apiKey, providerName);
      results[providerName] = {
        hasApiKey: !!config.apiKey,
        formatValid: isValid,
        keyPrefix: config.apiKey ? config.apiKey.substring(0, 8) + '...' : null
      };
    }

    return results;
  }

  /**
   * Get environment variable information
   * @returns {Object} Environment variable info
   */
  getEnvInfo() {
    const envVars = {};

    for (const providerName of this.getProviders()) {
      const providerEnv = {};
      const keys = ['apiKey', 'baseURL', 'timeout', 'retries'];

      for (const key of keys) {
        const envKey = `${this.envPrefix}_${providerName.toUpperCase()}_${key.toUpperCase()}`;
        providerEnv[key] = {
          envKey,
          hasValue: !!process.env[envKey],
          value: process.env[envKey] ? '[REDACTED]' : null
        };
      }

      envVars[providerName] = providerEnv;
    }

    return envVars;
  }

  /**
   * Create configuration template
   * @param {Array<string>} providers - Provider names
   * @returns {Object} Configuration template
   */
  static createTemplate(providers = ['openai', 'anthropic', 'google']) {
    const template = {};

    for (const provider of providers) {
      template[provider] = {
        apiKey: `\${${provider.toUpperCase()}_API_KEY}`,
        baseURL: null,
        timeout: 30000,
        retries: 3,
        defaultModel: null,
        maxTokens: 4096,
        temperature: 0.7
      };
    }

    return template;
  }

  /**
   * Generate environment variable documentation
   * @returns {string} Documentation string
   */
  generateEnvDocs() {
    const docs = [];
    docs.push('# Environment Variables for LLM SDK Providers\n');

    for (const providerName of this.getProviders()) {
      docs.push(`## ${providerName.toUpperCase()} Provider\n`);

      const envKeys = [
        'API_KEY',
        'BASE_URL',
        'TIMEOUT',
        'RETRIES',
        'DEFAULT_MODEL',
        'MAX_TOKENS',
        'TEMPERATURE'
      ];

      for (const key of envKeys) {
        const envKey = `${this.envPrefix}_${providerName.toUpperCase()}_${key}`;
        docs.push(`- \`${envKey}\`: ${this.getKeyDescription(key)}`);
      }

      docs.push('');
    }

    return docs.join('\n');
  }

  /**
   * Get description for configuration key
   * @param {string} key - Configuration key
   * @returns {string} Description
   */
  getKeyDescription(key) {
    const descriptions = {
      API_KEY: 'API key for the provider',
      BASE_URL: 'Custom base URL for API requests',
      TIMEOUT: 'Request timeout in milliseconds',
      RETRIES: 'Number of retry attempts',
      DEFAULT_MODEL: 'Default model to use',
      MAX_TOKENS: 'Maximum tokens for responses',
      TEMPERATURE: 'Default temperature for requests'
    };

    return descriptions[key] || 'Configuration value';
  }

  /**
   * Convert to JSON (with sensitive data redacted)
   * @returns {Object} JSON representation
   */
  toJSON() {
    const result = {
      providers: {},
      envPrefix: this.envPrefix,
      allowEnvOverrides: this.allowEnvOverrides
    };

    for (const [name, config] of this.configs) {
      result.providers[name] = {
        ...config,
        apiKey: config.apiKey ? '[REDACTED]' : null
      };
    }

    return result;
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.configs.clear();
    this.logger.info('ProviderConfig destroyed');
  }
}
