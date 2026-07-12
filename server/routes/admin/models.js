import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { getLocalizedContent } from '../../../shared/localize.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, validateIdsForPath } from '../../utils/pathSecurity.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import logger from '../../utils/logger.js';
import { removeMarketplaceInstallation } from '../../utils/installationCleanup.js';
import {
  sendInternalError,
  sendNotFound,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import { atomicWriteJSON, atomicCreateJSON } from '../../utils/atomicWrite.js';
import {
  clearOtherDefaults,
  promoteNewDefault,
  ensureDefaultAmongEnabled
} from '../../modelsLoader.js';

function modelFilePath(modelId) {
  return join(getRootDir(), 'contents', 'models', `${modelId}.json`);
}

export default function registerAdminModelsRoutes(app) {
  /**
   * @swagger
   * /admin/models:
   *   get:
   *     summary: Get all models (Admin)
   *     description: Retrieves all configured models including disabled ones (admin access required)
   *     tags:
   *       - Admin - Models
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: List of all models
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   id:
   *                     type: string
   *                   name:
   *                     type: string
   *                   provider:
   *                     type: string
   *                   enabled:
   *                     type: boolean
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/models'), adminAuth, async (req, res) => {
    try {
      const { data: models, etag: modelsEtag } = configCache.getModels(true);

      // Mask API keys in the response for security
      const maskedModels = models.map(model => {
        const maskedModel = { ...model };
        if (maskedModel.apiKey) {
          // Show masked value to indicate a key is set
          maskedModel.apiKeyMasked = '••••••••';
          maskedModel.apiKeySet = true;
          // Remove the actual encrypted key from response
          delete maskedModel.apiKey;
        } else {
          maskedModel.apiKeySet = false;
        }
        return maskedModel;
      });

      res.setHeader('ETag', modelsEtag);
      res.json(maskedModels);
    } catch (error) {
      return sendInternalError(res, error, 'fetch all models');
    }
  });

  app.get(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const { data: models, etag: modelsEtag } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return sendNotFound(res, 'Model');
      }

      // Mask API key in the response for security
      const maskedModel = { ...model };
      if (maskedModel.apiKey) {
        // Show masked value to indicate a key is set
        maskedModel.apiKeyMasked = '••••••••';
        maskedModel.apiKeySet = true;
        // Remove the actual encrypted key from response
        delete maskedModel.apiKey;
      } else {
        maskedModel.apiKeySet = false;
      }

      res.setHeader('ETag', modelsEtag);
      res.json(maskedModel);
    } catch (error) {
      return sendInternalError(res, error, 'fetch model');
    }
  });

  app.put(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;
      const updatedModel = req.body;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      if (
        !updatedModel.id ||
        !getLocalizedContent(updatedModel.name, defaultLang) ||
        !getLocalizedContent(updatedModel.description, defaultLang) ||
        !updatedModel.provider
      ) {
        return sendBadRequest(res, 'Missing required fields');
      }
      if (updatedModel.id !== modelId) {
        return sendBadRequest(res, 'Model ID cannot be changed');
      }

      // Handle API key encryption
      if (updatedModel.apiKey) {
        // Check if this is a new key or unchanged masked value
        if (updatedModel.apiKey !== '••••••••') {
          // New key provided - encrypt it
          try {
            updatedModel.apiKey = tokenStorageService.encryptString(updatedModel.apiKey);
          } catch (error) {
            return sendInternalError(res, error, 'encrypt API key');
          }
        } else {
          // Masked value - need to preserve existing key
          // CRITICAL FIX: Read from disk, not cache, to ensure we have the apiKey field
          // The cache might not have the apiKey due to TTL expiration or race conditions
          const existingModelPath = modelFilePath(modelId);

          try {
            if (existsSync(existingModelPath)) {
              const existingModelFromDisk = JSON.parse(
                await fs.readFile(existingModelPath, 'utf8')
              );
              if (existingModelFromDisk.apiKey) {
                // Preserve the existing encrypted API key from disk
                updatedModel.apiKey = existingModelFromDisk.apiKey;
              } else {
                // No existing key on disk, remove the masked placeholder
                delete updatedModel.apiKey;
              }
            } else {
              // File doesn't exist yet (shouldn't happen in update), remove placeholder
              delete updatedModel.apiKey;
            }
          } catch (error) {
            logger.error('Error reading existing model from disk', {
              component: 'ModelsRoutes',
              error
            });
            // Fallback to removing the masked placeholder
            delete updatedModel.apiKey;
          }
        }
      }

      // Remove client-side helper fields
      delete updatedModel.apiKeySet;
      delete updatedModel.apiKeyMasked;

      // Capture old model state before writing
      const { data: currentModels } = configCache.getModels(true);
      const oldModel = currentModels.find(m => m.id === modelId);

      if (updatedModel.default === true) {
        const othersCleared = clearOtherDefaults(currentModels, modelId);
        for (const model of othersCleared) {
          await atomicWriteJSON(modelFilePath(model.id), model);
        }
      }

      await atomicWriteJSON(modelFilePath(modelId), updatedModel);
      await configCache.refreshModelsCache();
      if (oldModel) {
        await saveSnapshot({
          resource: 'model',
          id: modelId,
          before: oldModel,
          after: updatedModel,
          admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
        });
      }
      await logAudit({
        req,
        action: 'update',
        resource: 'model',
        resourceId: modelId,
        summary: `Updated model ${modelId}`
      });
      res.json({ message: 'Model updated successfully', model: updatedModel });
    } catch (error) {
      return sendInternalError(res, error, 'update model');
    }
  });

  app.post(buildServerPath('/api/admin/models'), adminAuth, async (req, res) => {
    try {
      const newModel = req.body;
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      if (
        !newModel.id ||
        !getLocalizedContent(newModel.name, defaultLang) ||
        !getLocalizedContent(newModel.description, defaultLang) ||
        !newModel.provider
      ) {
        return sendBadRequest(res, 'Missing required fields');
      }

      // Validate newModel.id for security
      if (!validateIdForPath(newModel.id, 'model', res)) {
        return;
      }

      // Handle API key encryption
      if (newModel.apiKey && newModel.apiKey !== '••••••••') {
        // New key provided - encrypt it
        try {
          newModel.apiKey = tokenStorageService.encryptString(newModel.apiKey);
        } catch (error) {
          return sendInternalError(res, error, 'encrypt API key');
        }
      } else if (newModel.apiKey === '••••••••') {
        // Remove masked placeholder if no real key
        delete newModel.apiKey;
      }

      // Remove client-side helper fields
      delete newModel.apiKeySet;
      delete newModel.apiKeyMasked;

      try {
        await atomicCreateJSON(modelFilePath(newModel.id), newModel);
      } catch (error) {
        if (error.code === 'EEXIST') {
          return sendErrorResponse(res, 409, 'Model with this ID already exists');
        }
        throw error;
      }

      if (newModel.default === true) {
        const { data: currentModels } = configCache.getModels(true);
        const othersCleared = clearOtherDefaults(currentModels, newModel.id);
        for (const model of othersCleared) {
          await atomicWriteJSON(modelFilePath(model.id), model);
        }
      }
      await configCache.refreshModelsCache();
      await logAudit({
        req,
        action: 'create',
        resource: 'model',
        resourceId: newModel.id,
        summary: `Created model ${newModel.id}`
      });
      res.json({ message: 'Model created successfully', model: newModel });
    } catch (error) {
      return sendInternalError(res, error, 'create model');
    }
  });

  app.post(buildServerPath('/api/admin/models/:modelId/toggle'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return sendNotFound(res, 'Model');
      }
      const newEnabledState = !model.enabled;
      model.enabled = newEnabledState;
      if (!newEnabledState && model.default === true) {
        const promoted = promoteNewDefault(models, modelId);
        if (promoted) {
          await atomicWriteJSON(modelFilePath(promoted.id), promoted);
        }
        model.default = false;
      }
      await atomicWriteJSON(modelFilePath(modelId), model);
      await configCache.refreshModelsCache();
      await logAudit({
        req,
        action: 'toggle',
        resource: 'model',
        resourceId: modelId,
        summary: `${newEnabledState ? 'Enabled' : 'Disabled'} model ${modelId}`
      });
      res.json({
        message: `Model ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
        model: model,
        enabled: newEnabledState
      });
    } catch (error) {
      return sendInternalError(res, error, 'toggle model');
    }
  });

  app.post(buildServerPath('/api/admin/models/:modelIds/_toggle'), adminAuth, async (req, res) => {
    try {
      const { modelIds } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return sendBadRequest(res, 'Missing enabled flag');
      }

      // Validate modelIds for security
      const ids = validateIdsForPath(modelIds, 'model', res);
      if (!ids) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const resolvedIds = ids.includes('*') ? models.map(m => m.id) : ids;

      for (const id of resolvedIds) {
        const model = models.find(m => m.id === id);
        if (!model) continue;
        model.enabled = enabled;
        if (!enabled) {
          model.default = false;
        }
        await atomicWriteJSON(modelFilePath(id), model);
      }

      // ensure at least one enabled model has default=true
      const promoted = ensureDefaultAmongEnabled(models);
      if (promoted) {
        await atomicWriteJSON(modelFilePath(promoted.id), promoted);
      }

      await configCache.refreshModelsCache();
      await logAudit({
        req,
        action: 'toggle',
        resource: 'model',
        resourceId: resolvedIds.join(','),
        summary: `Batch ${enabled ? 'enabled' : 'disabled'} ${resolvedIds.length} models`
      });
      res.json({
        message: `Models ${enabled ? 'enabled' : 'disabled'} successfully`,
        enabled,
        ids: resolvedIds
      });
    } catch (error) {
      return sendInternalError(res, error, 'toggle models');
    }
  });

  app.delete(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return sendNotFound(res, 'Model');
      }
      if (model.default === true) {
        const promoted = promoteNewDefault(models, modelId);
        if (promoted) {
          await atomicWriteJSON(modelFilePath(promoted.id), promoted);
        }
      }
      const filePath = modelFilePath(modelId);
      if (!existsSync(filePath)) {
        return sendNotFound(res, 'Model file');
      }
      await fs.unlink(filePath);
      await configCache.refreshModelsCache();
      await removeMarketplaceInstallation('model', modelId);
      if (model) {
        await saveSnapshot({
          resource: 'model',
          id: modelId,
          before: model,
          after: null,
          admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
        });
      }
      await logAudit({
        req,
        action: 'delete',
        resource: 'model',
        resourceId: modelId,
        summary: `Deleted model ${modelId}`
      });
      res.json({ message: 'Model deleted successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'delete model');
    }
  });

  app.post(buildServerPath('/api/admin/models/:modelId/test'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return sendNotFound(res, 'Model');
      }
      const testMessage = 'Hello, can you respond with a simple "Test successful" message?';
      const { simpleCompletion } = await import('../../utils.js');
      const { verifyApiKey } = await import('../../serverHelpers.js');
      const apiKey = await verifyApiKey(model, res);
      if (!apiKey) {
        return;
      }
      try {
        const result = await simpleCompletion(testMessage, {
          modelId: model.id,
          apiKey: apiKey
        });
        res.json({
          success: true,
          message: 'Model test successful',
          response: result.content,
          model: model
        });
      } catch (testError) {
        logger.error('Model test failed', { component: 'ModelsRoutes', error: testError });
        let errorMessage = 'Unknown error occurred';
        let userMessage = 'Model test failed';
        if (testError.message.includes('fetch failed')) {
          if (testError.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
            userMessage = 'Connection timeout';
            errorMessage =
              'The model service did not respond within the timeout period. Please check if the model URL is correct and the service is running.';
          } else if (testError.cause?.code === 'ECONNREFUSED') {
            userMessage = 'Connection refused';
            errorMessage =
              'Unable to connect to the model service. Please verify the URL and ensure the service is running.';
          } else if (testError.cause?.code === 'ENOTFOUND') {
            userMessage = 'Service not found';
            errorMessage =
              'The model service hostname could not be resolved. Please check the URL configuration.';
          } else {
            userMessage = 'Network error';
            errorMessage = `Network connection failed: ${testError.cause?.message || testError.message}`;
          }
        } else if (testError.message.includes('timeout')) {
          userMessage = 'Request timeout';
          errorMessage =
            'The model service took too long to respond. Please try again or check the service status.';
        } else if (testError.message.includes('401')) {
          userMessage = 'Authentication failed';
          errorMessage =
            'Invalid API key or authentication credentials. Please check your model configuration.';
        } else if (testError.message.includes('403')) {
          userMessage = 'Access denied';
          errorMessage =
            'Access denied by the model service. Please check your API key permissions.';
        } else if (testError.message.includes('404')) {
          userMessage = 'Model not found';
          errorMessage =
            'The specified model was not found on the service. Please check the model ID configuration.';
        } else if (testError.message.includes('429')) {
          userMessage = 'Rate limit exceeded';
          errorMessage = 'Too many requests to the model service. Please try again later.';
        } else if (testError.message.includes('500')) {
          userMessage = 'Server error';
          errorMessage = 'The model service encountered an internal error. Please try again later.';
        } else {
          errorMessage = testError.message;
        }
        sendInternalError(res, new Error(errorMessage), `test model: ${userMessage}`);
      }
    } catch (error) {
      logger.error('Error testing model', { component: 'ModelsRoutes', error });
      sendInternalError(res, error, 'test model');
    }
  });
}
