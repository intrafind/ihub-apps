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
    if (model.provider && model.provider.toLowerCase() === 'iassistant-conversation') {
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
      logger.error('Error getting API key for model', {
        component: 'ApiKeyVerifier',
        modelId: model.id,
        error
      });

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
    const providers = ['openai', 'anthropic', 'google', 'mistral', 'bedrock'];
    const missing = [];

    for (const provider of providers) {
      const envVar = `${provider.toUpperCase()}_API_KEY`;
      if (!process.env[envVar]) {
        missing.push(provider);
      }
    }

    if (missing.length > 0) {
      logger.warn('Missing API keys for providers', {
        component: 'ApiKeyVerifier',
        missing
      });
      logger.warn('Some models may not work. Please check your .env file configuration.', {
        component: 'ApiKeyVerifier'
      });
      return { valid: false, missing };
    } else {
      logger.info('All provider API keys are configured', { component: 'ApiKeyVerifier' });
      return { valid: true, missing: [] };
    }
  }

  /**
   * Validate API keys for enabled models only
   * Now checks model config, provider config, and environment variables
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
    const checkedProviders = new Set(); // Track which providers we've already validated

    // Get provider configurations
    let providers = [];
    try {
      const providersData = configCache.getProviders(true);
      providers = providersData?.data || [];
    } catch (error) {
      logger.error('Error loading provider configurations', {
        component: 'ApiKeyVerifier',
        error
      });
    }

    for (const model of enabledModels) {
      if (!model.provider) continue;

      const provider = model.provider.toLowerCase();

      // Skip providers that don't need API keys
      if (provider === 'iassistant-conversation') {
        validKeys.add(provider);
        continue;
      }

      // Check if this specific model has an API key configured
      if (model.apiKey) {
        validKeys.add(provider);
        continue;
      }

      // Check if we've already validated this provider
      if (checkedProviders.has(provider)) {
        // Use cached result
        if (!validKeys.has(provider) && !missingKeys.has(provider)) {
          if (!missingKeys.has(provider)) {
            missingKeys.set(provider, []);
          }
          missingKeys.get(provider).push(model.id);
        }
        continue;
      }

      // Mark this provider as checked
      checkedProviders.add(provider);

      // Check provider-level API key in providers.json
      const providerConfig = providers.find(p => p.id === provider);
      if (providerConfig && providerConfig.apiKey) {
        validKeys.add(provider);
        continue;
      }

      // Check for model-specific environment variable
      const modelSpecificKeyName = `${model.id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      if (process.env[modelSpecificKeyName]) {
        validKeys.add(provider);
        continue;
      }

      // Check for provider-specific environment variable
      const envVar = `${provider.toUpperCase()}_API_KEY`;
      if (process.env[envVar]) {
        validKeys.add(provider);
        continue;
      }

      // Check if model has a custom URL (might be local provider that doesn't need API key)
      if (model.url && provider === 'openai') {
        // For OpenAI-compatible local providers with custom URLs,
        // an API key might not be required or can be any value
        // We'll still warn but with lower priority
        validKeys.add(provider);
        continue;
      }

      // No API key found through any method
      if (!missingKeys.has(provider)) {
        missingKeys.set(provider, []);
      }
      missingKeys.get(provider).push(model.id);
    }

    // Log results
    if (missingKeys.size > 0) {
      logger.warn('API key validation: missing keys detected', { component: 'ApiKeyVerifier' });
      for (const [provider, modelIds] of missingKeys) {
        logger.warn('Missing API key for provider', {
          component: 'ApiKeyVerifier',
          provider,
          envVar: `${provider.toUpperCase()}_API_KEY`,
          modelIds
        });
      }
      logger.warn(
        'Please configure missing API keys via Admin → Providers, model configuration, or environment variables',
        {
          component: 'ApiKeyVerifier'
        }
      );
      return { valid: false, missing: Object.fromEntries(missingKeys) };
    } else if (enabledModels.length > 0) {
      logger.info('All API keys configured for enabled models', {
        component: 'ApiKeyVerifier',
        count: enabledModels.length
      });
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
      logger.warn('Environment variable validation: missing variables detected', {
        component: 'ApiKeyVerifier',
        configName,
        missing: Array.from(missingVars)
      });
      return { valid: false, missing: Array.from(missingVars) };
    } else if (foundVars.size > 0) {
      logger.info('All environment variables found', {
        component: 'ApiKeyVerifier',
        configName,
        count: foundVars.size
      });
      return { valid: true, found: Array.from(foundVars) };
    }

    return { valid: true, found: [] };
  }
}

export default ApiKeyVerifier;
