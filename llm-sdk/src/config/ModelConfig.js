import { Validator, modelConfigSchema } from '../utils/Validator.js';
import { ConfigurationError } from '../utils/ErrorHandler.js';
import { defaultLogger } from '../utils/Logger.js';
import { readFile, writeFile, access } from 'fs/promises';
import { join, dirname } from 'path';

/**
 * Model configuration management
 */
export class ModelConfig {
  constructor(options = {}) {
    this.logger = options.logger || defaultLogger.child('ModelConfig');
    this.models = new Map();
    this.configPath = options.configPath;
    this.autoReload = options.autoReload || false;
    this.reloadInterval = options.reloadInterval || 60000; // 1 minute
    this.watchTimeout = null;
  }

  /**
   * Load models from configuration file or object
   * @param {string|Object|Array} source - File path, config object, or array of models
   * @returns {Promise<void>}
   */
  async load(source) {
    try {
      let modelsData;

      if (typeof source === 'string') {
        // Load from file
        this.configPath = source;
        modelsData = await this.loadFromFile(source);
      } else if (Array.isArray(source)) {
        // Load from array
        modelsData = source;
      } else if (typeof source === 'object') {
        // Load from object
        modelsData = source.models || [source];
      } else {
        throw new ConfigurationError('Invalid model configuration source', 'source', null);
      }

      this.parseModels(modelsData);

      this.logger.info(`Loaded ${this.models.size} model configurations`);

      if (this.autoReload && this.configPath) {
        this.startAutoReload();
      }
    } catch (error) {
      this.logger.error('Failed to load model configurations', error);
      throw new ConfigurationError(
        `Failed to load model configurations: ${error.message}`,
        'load',
        source,
        error
      );
    }
  }

  /**
   * Load models from file
   * @param {string} filePath - Path to configuration file
   * @returns {Promise<Array|Object>} Models data
   */
  async loadFromFile(filePath) {
    try {
      await access(filePath);
      const fileContent = await readFile(filePath, 'utf8');
      return JSON.parse(fileContent);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ConfigurationError(
          `Model configuration file not found: ${filePath}`,
          'configPath',
          filePath
        );
      }
      throw error;
    }
  }

  /**
   * Parse and validate model configurations
   * @param {Array|Object} modelsData - Models data to parse
   */
  parseModels(modelsData) {
    this.models.clear();

    // Handle both array format and object format
    const modelList = Array.isArray(modelsData) ? modelsData : modelsData.models || [modelsData];

    for (const [index, modelData] of modelList.entries()) {
      try {
        const validatedModel = Validator.validateModelConfig(modelData);
        const modelInstance = new Model(validatedModel);

        if (this.models.has(modelInstance.id)) {
          this.logger.warn(`Duplicate model ID: ${modelInstance.id}`);
        }

        this.models.set(modelInstance.id, modelInstance);
      } catch (error) {
        this.logger.error(`Failed to parse model at index ${index}:`, error);
        throw new ConfigurationError(
          `Failed to parse model at index ${index}: ${error.message}`,
          `models[${index}]`,
          modelData,
          error
        );
      }
    }
  }

  /**
   * Get model by ID
   * @param {string} modelId - Model ID
   * @returns {Model|null} Model instance or null if not found
   */
  getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  /**
   * Get models by provider
   * @param {string} provider - Provider name
   * @returns {Array<Model>} Models for the provider
   */
  getModelsByProvider(provider) {
    return Array.from(this.models.values()).filter(model => model.provider === provider);
  }

  /**
   * Get all models
   * @returns {Array<Model>} All model instances
   */
  getAllModels() {
    return Array.from(this.models.values());
  }

  /**
   * Get model IDs
   * @returns {Array<string>} Model IDs
   */
  getModelIds() {
    return Array.from(this.models.keys());
  }

  /**
   * Check if model exists
   * @param {string} modelId - Model ID
   * @returns {boolean} Whether model exists
   */
  hasModel(modelId) {
    return this.models.has(modelId);
  }

  /**
   * Add or update model
   * @param {Object} modelData - Model data
   * @returns {Model} Created model instance
   */
  addModel(modelData) {
    const validatedModel = Validator.validateModelConfig(modelData);
    const modelInstance = new Model(validatedModel);

    this.models.set(modelInstance.id, modelInstance);
    this.logger.info(`Added model: ${modelInstance.id}`);

    return modelInstance;
  }

  /**
   * Remove model
   * @param {string} modelId - Model ID
   * @returns {boolean} Whether model was removed
   */
  removeModel(modelId) {
    const removed = this.models.delete(modelId);
    if (removed) {
      this.logger.info(`Removed model: ${modelId}`);
    }
    return removed;
  }

  /**
   * Save models to file
   * @param {string} filePath - Optional file path (uses configPath if not provided)
   * @returns {Promise<void>}
   */
  async save(filePath = null) {
    const targetPath = filePath || this.configPath;

    if (!targetPath) {
      throw new ConfigurationError('No file path specified for saving models', 'filePath');
    }

    try {
      const modelsData = this.getAllModels().map(model => model.toJSON());
      const jsonData = JSON.stringify({ models: modelsData }, null, 2);

      await writeFile(targetPath, jsonData, 'utf8');
      this.logger.info(`Saved ${modelsData.length} models to ${targetPath}`);
    } catch (error) {
      throw new ConfigurationError(
        `Failed to save models to ${targetPath}: ${error.message}`,
        'save',
        targetPath,
        error
      );
    }
  }

  /**
   * Start auto-reload functionality
   */
  startAutoReload() {
    if (this.watchTimeout) {
      clearInterval(this.watchTimeout);
    }

    this.watchTimeout = setInterval(async () => {
      try {
        this.logger.debug('Auto-reloading model configurations');
        await this.reload();
      } catch (error) {
        this.logger.error('Auto-reload failed:', error);
      }
    }, this.reloadInterval);

    this.logger.info(`Started auto-reload with ${this.reloadInterval}ms interval`);
  }

  /**
   * Stop auto-reload functionality
   */
  stopAutoReload() {
    if (this.watchTimeout) {
      clearInterval(this.watchTimeout);
      this.watchTimeout = null;
      this.logger.info('Stopped auto-reload');
    }
  }

  /**
   * Reload configuration from source
   * @returns {Promise<void>}
   */
  async reload() {
    if (!this.configPath) {
      throw new ConfigurationError('No configuration path set for reload', 'configPath');
    }

    const oldModelCount = this.models.size;
    await this.load(this.configPath);

    this.logger.info(`Reloaded models: ${oldModelCount} -> ${this.models.size}`);
  }

  /**
   * Filter models by criteria
   * @param {Function} predicate - Filter function
   * @returns {Array<Model>} Filtered models
   */
  filter(predicate) {
    return this.getAllModels().filter(predicate);
  }

  /**
   * Find model by criteria
   * @param {Function} predicate - Find function
   * @returns {Model|null} Found model or null
   */
  find(predicate) {
    return this.getAllModels().find(predicate) || null;
  }

  /**
   * Get models with specific capability
   * @param {string} capability - Capability name
   * @returns {Array<Model>} Models with capability
   */
  getModelsWithCapability(capability) {
    return this.filter(model => model.hasCapability(capability));
  }

  /**
   * Get configuration statistics
   * @returns {Object} Statistics
   */
  getStats() {
    const stats = {
      totalModels: this.models.size,
      providers: {},
      capabilities: {}
    };

    for (const model of this.models.values()) {
      // Provider stats
      if (!stats.providers[model.provider]) {
        stats.providers[model.provider] = 0;
      }
      stats.providers[model.provider]++;

      // Capability stats
      for (const capability of Object.keys(model.capabilities || {})) {
        if (!stats.capabilities[capability]) {
          stats.capabilities[capability] = 0;
        }
        if (model.capabilities[capability]) {
          stats.capabilities[capability]++;
        }
      }
    }

    return stats;
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      models: this.getAllModels().map(model => model.toJSON()),
      stats: this.getStats(),
      config: {
        configPath: this.configPath,
        autoReload: this.autoReload,
        reloadInterval: this.reloadInterval
      }
    };
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.stopAutoReload();
    this.models.clear();
    this.logger.info('ModelConfig destroyed');
  }
}

/**
 * Individual model configuration
 */
export class Model {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.provider = config.provider;
    this.capabilities = config.capabilities || {};
    this.limits = config.limits || {};
    this.pricing = config.pricing || {};
    this.metadata = config.metadata || {};
    this.createdAt = new Date();
  }

  /**
   * Check if model has specific capability
   * @param {string} capability - Capability name
   * @returns {boolean} Whether model has capability
   */
  hasCapability(capability) {
    return !!(this.capabilities && this.capabilities[capability]);
  }

  /**
   * Get capability value
   * @param {string} capability - Capability name
   * @param {*} defaultValue - Default value if capability not found
   * @returns {*} Capability value
   */
  getCapability(capability, defaultValue = false) {
    return this.capabilities[capability] ?? defaultValue;
  }

  /**
   * Get limit value
   * @param {string} limit - Limit name
   * @param {*} defaultValue - Default value if limit not found
   * @returns {*} Limit value
   */
  getLimit(limit, defaultValue = null) {
    return this.limits[limit] ?? defaultValue;
  }

  /**
   * Get pricing information
   * @param {string} type - Pricing type (input/output)
   * @returns {number|null} Price per token
   */
  getPrice(type) {
    return this.pricing[type] ?? null;
  }

  /**
   * Calculate estimated cost for token usage
   * @param {number} inputTokens - Input tokens
   * @param {number} outputTokens - Output tokens
   * @returns {number|null} Estimated cost or null if pricing unavailable
   */
  calculateCost(inputTokens, outputTokens) {
    const inputPrice = this.getPrice('input');
    const outputPrice = this.getPrice('output');

    if (inputPrice === null || outputPrice === null) {
      return null;
    }

    return inputTokens * inputPrice + outputTokens * outputPrice;
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      capabilities: this.capabilities,
      limits: this.limits,
      pricing: this.pricing,
      metadata: this.metadata
    };
  }

  /**
   * Create model from JSON
   * @param {Object} data - JSON data
   * @returns {Model} Model instance
   */
  static fromJSON(data) {
    return new Model(data);
  }
}
