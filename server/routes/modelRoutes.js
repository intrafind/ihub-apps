import configCache from '../configCache.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { authRequired, modelAccessRequired } from '../middleware/authRequired.js';
import {
  sendFailedOperationError,
  sendNotFound,
  sendInternalError
} from '../utils/responseHelpers.js';
import { buildServerPath } from '../utils/basePath.js';

export default function registerModelRoutes(app, { getLocalizedError }) {
  /**
   * @swagger
   * /models:
   *   get:
   *     summary: Get available models
   *     description: |
   *       Retrieves a list of all available AI models that the user has access to.
   *       Supports conditional requests using ETag for efficient caching.
   *       Include 'If-None-Match' header with previously received ETag to get 304 Not Modified
   *       response if the models list hasn't changed.
   *     tags:
   *       - Models
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: header
   *         name: If-None-Match
   *         required: false
   *         schema:
   *           type: string
   *         description: Client ETag for conditional requests (304 response if unchanged)
   *     responses:
   *       200:
   *         description: List of available models
   *         headers:
   *           ETag:
   *             description: Entity tag for cache validation
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 models:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                         description: Unique model identifier
   *                       name:
   *                         type: string
   *                         description: Human-readable model name
   *                       description:
   *                         type: string
   *                         description: Model description
   *                       provider:
   *                         type: string
   *                         description: AI provider (openai, anthropic, google, etc.)
   *                       enabled:
   *                         type: boolean
   *                         description: Whether the model is enabled
   *       304:
   *         description: Not Modified - content hasn't changed (ETag match)
   *       401:
   *         description: Authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/models'), authRequired, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

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

      // Handle conditional requests with ETag
      if (userSpecificEtag) {
        res.setHeader('ETag', userSpecificEtag);
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === userSpecificEtag) {
          return res.status(304).end();
        }
      }

      res.json(models);
    } catch (error) {
      sendInternalError(res, error, 'fetching models');
    }
  });

  app.get(
    buildServerPath('/api/models/:modelId'),
    authRequired,
    modelAccessRequired,
    async (req, res) => {
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
    }
  );
}
