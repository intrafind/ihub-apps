import { getApiKeyForModel } from '../utils.js';
import ErrorHandler from './ErrorHandler.js';
import { sendSSE } from '../sse.js';
import configCache from '../configCache.js';
import logger from './logger.js';

class ApiKeyVerifier {
  constructor() {
    this.errorHandler = new ErrorHandler();
  }

  async verifyApiKey(model, res = null, clientRes = null, language = null) {
    const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
    const lang = language || defaultLang;

    // Skip API key verification for providers that don't need keys
    if (model.provider && model.provider.toLowerCase() === 'iassistant') {
      return { success: true, apiKey: null };
    }

    try {
      const apiKey = await getApiKeyForModel(model.id);

      if (!apiKey) {
        logger.error(
          `API key not found for model: ${model.id} (${model.provider}). Please set ${model.provider.toUpperCase()}_API_KEY in your environment.`,
          { component: 'ApiKeyVerifier' }
        );

        const error = await this.errorHandler.createApiKeyError(model.provider, lang);

        if (clientRes) {
          sendSSE(clientRes, 'error', { message: error.message });
        }

        if (res) {
          res.status(401).json(this.errorHandler.formatErrorResponse(error));
        }

        return { success: false, error };
      }

      return { success: true, apiKey };
    } catch (error) {
      logger.error(`Error getting API key for model ${model.id}:`, { component: 'ApiKeyVerifier', error });

      const internalError = await this.errorHandler.getLocalizedError('internalError', {}, lang);
      const chatError = new Error(internalError);
      chatError.code = 'INTERNAL_ERROR';

      if (clientRes) {
        sendSSE(clientRes, 'error', { message: internalError });
      }

      if (res) {
        res.status(500).json({ error: internalError, code: 'INTERNAL_ERROR' });
      }

      return { success: false, error: chatError };
    }
  }

  async validateApiKeys() {
    const providers = ['openai', 'anthropic', 'google', 'mistral'];
    const missing = [];

    for (const provider of providers) {
      const envVar = `${provider.toUpperCase()}_API_KEY`;
      if (!process.env[envVar]) {
        missing.push(provider);
      }
    }

    if (missing.length > 0) {
      logger.warn(`⚠️ WARNING: Missing API keys for providers: ${missing.join(', ')}`, { component: 'ApiKeyVerifier' });
      logger.warn('Some models may not work. Please check your .env file configuration.', { component: 'ApiKeyVerifier' });
      return { valid: false, missing };
    } else {
      logger.info('✓ All provider API keys are configured', { component: 'ApiKeyVerifier' });
      return { valid: true, missing: [] };
    }
  }

  /**
   * Validate API keys for enabled models only
   * @param {Array} models - Array of model configurations
   * @returns {Object} Validation results with missing keys for enabled models
   */
  async validateEnabledModelsApiKeys(models = null) {
    if (!models) {
      models = configCache.getModels() || [];
    }

    const enabledModels = models.filter(model => model.enabled);
    const missingKeys = new Map();
    const validKeys = new Set();

    for (const model of enabledModels) {
      if (!model.provider) continue;

      const provider = model.provider.toLowerCase();

      // Skip providers that don't need API keys
      if (provider === 'iassistant') {
        validKeys.add(provider);
        continue;
      }

      const envVar = `${provider.toUpperCase()}_API_KEY`;

      // Skip if we already checked this provider
      if (validKeys.has(provider) || missingKeys.has(provider)) continue;

      // Check if API key exists
      if (!process.env[envVar]) {
        if (!missingKeys.has(provider)) {
          missingKeys.set(provider, []);
        }
        missingKeys.get(provider).push(model.id);
      } else {
        validKeys.add(provider);
      }
    }

    // Log results
    if (missingKeys.size > 0) {
      logger.warn('\n⚠️  API Key Validation Results:', { component: 'ApiKeyVerifier' });
      for (const [provider, modelIds] of missingKeys) {
        logger.warn(`   ❌ ${provider.toUpperCase()}: Missing ${provider.toUpperCase()}_API_KEY`, { component: 'ApiKeyVerifier' });
        logger.warn(`      Required for models: ${modelIds.join(', ')}`, { component: 'ApiKeyVerifier' });
      }
      logger.warn('   Please add the missing API keys to your .env or config.env file\n', { component: 'ApiKeyVerifier' });
      return { valid: false, missing: Object.fromEntries(missingKeys) };
    } else if (enabledModels.length > 0) {
      logger.info(`✅ All API keys configured for ${enabledModels.length} enabled models`, { component: 'ApiKeyVerifier' });
      return { valid: true, missing: {} };
    }

    return { valid: true, missing: {} };
  }

  /**
   * Validate environment variables used in configuration
   * @param {Object} config - Configuration object to scan
   * @param {string} configName - Name of the configuration for logging
   * @returns {Object} Validation results with missing variables
   */
  validateEnvironmentVariables(config, configName = 'configuration') {
    const missingVars = new Set();
    const foundVars = new Set();

    // Recursively scan for ${VARIABLE} patterns
    const scanForVariables = (obj, path = '') => {
      if (!obj || typeof obj !== 'object') {
        if (typeof obj === 'string') {
          // Find all ${VARIABLE} patterns
          const matches = obj.matchAll(/\$\{([^}]+)\}/g);
          for (const match of matches) {
            const varName = match[1];
            if (process.env[varName] === undefined) {
              missingVars.add(varName);
            } else {
              foundVars.add(varName);
            }
          }
        }
        return;
      }

      if (Array.isArray(obj)) {
        obj.forEach((item, index) => scanForVariables(item, `${path}[${index}]`));
      } else {
        for (const [key, value] of Object.entries(obj)) {
          scanForVariables(value, path ? `${path}.${key}` : key);
        }
      }
    };

    scanForVariables(config);

    // Log results
    if (missingVars.size > 0) {
      logger.warn(`\n⚠️  Environment Variable Validation for ${configName}:`, { component: 'ApiKeyVerifier' });
      logger.warn(`   ❌ Missing variables: ${Array.from(missingVars).join(', ')}`, { component: 'ApiKeyVerifier' });
      logger.warn('   These variables are referenced in configuration but not set\n', { component: 'ApiKeyVerifier' });
      return { valid: false, missing: Array.from(missingVars) };
    } else if (foundVars.size > 0) {
      logger.info(`✅ All ${foundVars.size} environment variables found for ${configName}`, { component: 'ApiKeyVerifier' });
      return { valid: true, found: Array.from(foundVars) };
    }

    return { valid: true, found: [] };
  }
}

export default ApiKeyVerifier;
