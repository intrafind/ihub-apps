import configCache from '../configCache.js';
import {
  canUserAccessResource,
  isAnonymousAccessAllowed,
  enhanceUserWithPermissions
} from '../utils/authorization.js';
import { authRequired } from '../middleware/authRequired.js';
import {
  sendFailedOperationError,
  sendNotFound,
  sendInternalError
} from '../utils/responseHelpers.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';

/**
 * Strip server-side secrets before a model is sent to the browser.
 * - `apiKey` (an encrypted ciphertext blob) is removed for EVERY model.
 * - `url` is removed for transcription and text-to-speech models so a
 *   self-hosted endpoint never reaches the browser (the acceptance criterion
 *   for issue #1927). Chat models keep their `url` (the client shows/uses it
 *   as today).
 */
function sanitizeModelForPublic(model) {
  const clean = { ...model };
  delete clean.apiKey;
  if (clean.modelType === 'transcription' || clean.modelType === 'tts') {
    delete clean.url;
  }
  return clean;
}

/** Model types `GET /api/models?type=` lists. */
const MODEL_TYPES = ['chat', 'transcription', 'tts'];

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
      const platformConfig = configCache.getPlatform() || {};
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

      // Filter by model type. Default to chat models so transcription models
      // never leak into the chat model selector, magic prompt, compare mode,
      // workflows, or the default-model fallback (G9). `?type=transcription`
      // returns the permitted transcription models (for the app editor picker),
      // `?type=tts` the permitted text-to-speech models (read aloud).
      // Unknown types are a 400, not a silent fallback to chat — otherwise a
      // future model type would silently return the wrong list.
      const requestedType = req.query.type ?? 'chat';
      if (!MODEL_TYPES.includes(requestedType)) {
        return res.status(400).json({ error: `Unknown model type: ${requestedType}` });
      }
      const typedModels = models.filter(m => (m.modelType || 'chat') === requestedType);

      // Strip server-side secrets (encrypted apiKey for all; url for
      // transcription and TTS models) so they never reach the browser (G2).
      const sanitizedModels = typedModels.map(sanitizeModelForPublic);

      // Discriminate the ETag by type so the chat and transcription lists don't
      // collide in the shared conditional-request cache.
      const typedEtag = userSpecificEtag ? `${userSpecificEtag}-${requestedType}` : null;

      // Handle conditional requests with ETag
      if (typedEtag) {
        res.setHeader('ETag', typedEtag);
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === typedEtag) {
          return res.status(304).end();
        }
      }

      res.json(sanitizedModels);
    } catch (error) {
      sendInternalError(res, error, 'fetching models');
    }
  });

  // No modelAccessRequired here: it answers 403, while this route gives one
  // answer (404) for a model that does not exist and one the caller may not use.
  app.get(buildServerPath('/api/models/:modelId'), authRequired, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId to prevent injection
      if (!validateIdForPath(modelId, 'model', res)) return;

      const platform = configCache.getPlatform() || {};
      const defaultLang = platform?.defaultLanguage || 'en';
      const language = req.headers['accept-language']?.split(',')[0] || defaultLang;

      // Try to get models from cache first
      const { data: models } = configCache.getModels();

      if (!models) {
        return sendFailedOperationError(res, 'load models configuration');
      }
      const model = findByIdCaseInsensitive(models, modelId);
      // Transcription and TTS models are not exposed through this public
      // chat-model route (G9); their internal url / apiKey must never reach
      // the browser. Treat them as not-found here.
      if (!model || (model.modelType || 'chat') !== 'chat') {
        const errorMessage = await getLocalizedError('modelNotFound', {}, language);
        return sendNotFound(res, errorMessage);
      }

      // Fails closed: without a principal carrying permissions nothing is granted.
      if (!canUserAccessResource(req.user, 'models', model.id)) {
        const errorMessage = await getLocalizedError('modelNotFound', {}, language);
        return sendNotFound(res, errorMessage);
      }

      // Strip server-side secrets (encrypted apiKey) before returning.
      res.json(sanitizeModelForPublic(model));
    } catch (error) {
      sendInternalError(res, error, 'fetching model details');
    }
  });
}
