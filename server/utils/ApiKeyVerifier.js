import { inspectModelApiKey, resolveModelApiKey } from '../utils.js';
import ErrorHandler from './ErrorHandler.js';
import configCache from '../configCache.js';
import { providerEnvKeyName } from '../services/llmProviders.js';
import logger from './logger.js';

class ApiKeyVerifier {
  constructor() {
    this.errorHandler = new ErrorHandler();
  }

  /**
   * Resolve the API key for a model. Never writes to a response: the caller
   * owns the reply (HTTP status or stream error) when `success` is false.
   * @param {Object} model
   * @param {string|null} [language] - for the localized error message
   * @returns {Promise<{success: boolean, apiKey?: string|null, error?: Error}>}
   */
  async verifyApiKey(model, language = null) {
    const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
    const lang = language || defaultLang;

    // Skip API key verification for providers that don't need keys
    if (model.provider && model.provider.toLowerCase() === 'iassistant-conversation') {
      return { success: true, apiKey: null };
    }

    try {
      const resolution = await resolveModelApiKey(model.id);

      if (resolution.state === 'ok') {
        return { success: true, apiKey: resolution.apiKey };
      }

      // A server such as vLLM or LM Studio needs no key: the call goes out
      // without an Authorization header rather than failing here.
      if (resolution.state === 'keyless') {
        return { success: true, apiKey: null };
      }

      if (resolution.state === 'undecryptable') {
        // Not the same as "no key": the key is there, but this server cannot
        // read it. Say so, because the fix is a different one.
        logger.error(
          `The API key stored for model ${model.id} (${resolution.source}) cannot be decrypted. ` +
            'The server encryption key differs from the one it was saved with — check TOKEN_ENCRYPTION_KEY ' +
            'and contents/.encryption-key on every instance, or enter the key again in the admin UI.',
          { component: 'ApiKeyVerifier', modelId: model.id, source: resolution.source }
        );

        const error = await this.errorHandler.createApiKeyUnreadableError(
          model.provider,
          model.id,
          lang
        );
        return { success: false, error };
      }

      logger.error(
        `API key not found for model: ${model.id} (${model.provider}). Set it on the model or its provider in the admin UI, ` +
          `or set ${model.provider.toUpperCase()}_API_KEY in your environment.`,
        { component: 'ApiKeyVerifier' }
      );

      const error = await this.errorHandler.createApiKeyError(model.provider, lang);
      return { success: false, error };
    } catch (error) {
      logger.error('Error getting API key for model', {
        component: 'ApiKeyVerifier',
        modelId: model.id,
        error
      });

      const internalError = await this.errorHandler.getLocalizedError('internalError', {}, lang);
      const chatError = new Error(internalError);
      chatError.code = 'INTERNAL_ERROR';
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
   * Validate API keys for enabled models only.
   *
   * Every model gets the verdict a chat request would: `inspectModelApiKey`
   * resolves the model's own key, its provider's and the environment's, so
   * start-up warnings cannot disagree with what happens on the first request,
   * and one model's outcome never decides another's (a keyless server at a
   * custom URL says nothing about an OpenAI model of the same API type).
   *
   * @param {Array} models - Array of model configurations
   * @returns {Object} `{valid, missing, unreadable}`: `missing` maps a provider
   *   to the enabled models that need a key and have none, `unreadable` lists
   *   the enabled models whose stored key cannot be decrypted
   */
  async validateEnabledModelsApiKeys(models = null) {
    if (!models) {
      models = configCache.getModels()?.data || [];
    }

    const enabledModels = models.filter(model => model.enabled);
    const missingKeys = new Map(); // provider id → model ids
    const unreadable = [];

    for (const model of enabledModels) {
      if (!model.provider) continue;

      // Skip providers that don't need API keys
      if (model.provider.toLowerCase() === 'iassistant-conversation') continue;

      const { state, providerId } = inspectModelApiKey(model, { quiet: true });
      if (state === 'undecryptable') {
        unreadable.push(model.id);
      } else if (state === 'missing') {
        if (!missingKeys.has(providerId)) missingKeys.set(providerId, []);
        missingKeys.get(providerId).push(model.id);
      }
    }

    if (unreadable.length > 0) {
      logger.error(
        'Stored API keys cannot be decrypted: the server encryption key is not the one they were saved with. ' +
          'Check TOKEN_ENCRYPTION_KEY and contents/.encryption-key on every instance, or enter the keys again.',
        { component: 'ApiKeyVerifier', modelIds: unreadable }
      );
    }

    if (missingKeys.size > 0) {
      logger.warn('API key validation: missing keys detected', { component: 'ApiKeyVerifier' });
      for (const [provider, modelIds] of missingKeys) {
        logger.warn('Missing API key for provider', {
          component: 'ApiKeyVerifier',
          provider,
          envVar: providerEnvKeyName(provider),
          modelIds
        });
      }
      logger.warn(
        'Please configure missing API keys via Admin → Providers, model configuration, or environment variables',
        {
          component: 'ApiKeyVerifier'
        }
      );
    }

    if (missingKeys.size > 0 || unreadable.length > 0) {
      return { valid: false, missing: Object.fromEntries(missingKeys), unreadable };
    }

    if (enabledModels.length > 0) {
      logger.info('All API keys configured for enabled models', {
        component: 'ApiKeyVerifier',
        count: enabledModels.length
      });
    }

    return { valid: true, missing: {}, unreadable: [] };
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
