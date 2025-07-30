import configCache from '../configCache.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { authRequired, authOptional, modelAccessRequired } from '../middleware/authRequired.js';
import {
  sendAuthRequired,
  sendFailedOperationError,
  sendNotFound,
  sendInternalError
} from '../utils/responseHelpers.js';

/**
 * Transform internal model format to OpenAI API compliant format
 * @param {Object} model - Internal model object
 * @returns {Object} OpenAI API compliant model object
 */
function transformModelToOpenAIFormat(model) {
  return {
    id: model.id || model.modelId,
    object: 'model',
    created: Math.floor(Date.now() / 1000), // Current timestamp as fallback
    owned_by: model.provider || 'organization'
  };
}

export default function registerModelRoutes(app, { getLocalizedError }) {
  app.get('/api/models', authOptional, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      // Check if anonymous access is allowed
      if (!isAnonymousAccessAllowed(platformConfig) && (!req.user || req.user.id === 'anonymous')) {
        return sendAuthRequired(res);
      }

      // Force permission enhancement if not already done
      if (req.user && !req.user.permissions) {
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      // Create anonymous user if none exists and anonymous access is allowed
      if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
        req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
      }

      // Use centralized method to get filtered models with user-specific ETag
      const { data: models, etag: userSpecificEtag } = await configCache.getModelsForUser(
        req.user,
        platformConfig
      );

      if (!models) {
        return sendFailedOperationError(res, 'load models configuration');
      }

      // Transform models to OpenAI API compliant format
      const transformedModels = models.map(transformModelToOpenAIFormat);
      
      // Return in OpenAI ListModelsResponse format
      const response = {
        object: 'list',
        data: transformedModels
      };

      res.setHeader('ETag', userSpecificEtag);
      res.json(response);
    } catch (error) {
      sendInternalError(res, error, 'fetching models');
    }
  });

  app.get('/api/models/:modelId', authRequired, modelAccessRequired, async (req, res) => {
    try {
      const { modelId } = req.params;
      const platform = configCache.getPlatform() || {};
      const defaultLang = platform?.defaultLanguage || 'en';
      const language = req.headers['accept-language']?.split(',')[0] || defaultLang;

      // Try to get models from cache first
      const { data: models } = configCache.getModels();

      if (!models) {
        return sendFailedOperationError(res, 'load models configuration');
      }
      const model = models.find(m => m.id === modelId);
      if (!model) {
        const errorMessage = await getLocalizedError('modelNotFound', {}, language);
        return sendNotFound(res, errorMessage);
      }

      // Check if user has permission to access this model
      if (req.user && req.user.permissions) {
        const allowedModels = req.user.permissions.models || new Set();
        if (!allowedModels.has('*') && !allowedModels.has(modelId)) {
          const errorMessage = await getLocalizedError('modelNotFound', {}, language);
          return sendNotFound(res, errorMessage);
        }
      }

      // Transform model to OpenAI API compliant format
      const transformedModel = transformModelToOpenAIFormat(model);
      res.json(transformedModel);
    } catch (error) {
      sendInternalError(res, error, 'fetching model details');
    }
  });
}
