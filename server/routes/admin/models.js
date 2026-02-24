import { readFileSync, existsSync } from 'fs';
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
      logger.error({
        component: 'ModelsRoutes',
        message: 'Error fetching all models',
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Failed to fetch models' });
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
        return res.status(404).json({ error: 'Model not found' });
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
      logger.error({
        component: 'ModelsRoutes',
        message: 'Error fetching model',
        modelId: req.params.modelId,
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Failed to fetch model' });
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
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (updatedModel.id !== modelId) {
        return res.status(400).json({ error: 'Model ID cannot be changed' });
      }

      // Handle API key encryption
      if (updatedModel.apiKey) {
        // Check if this is a new key or unchanged masked value
        if (updatedModel.apiKey !== '••••••••') {
          // New key provided - encrypt it
          try {
            updatedModel.apiKey = tokenStorageService.encryptString(updatedModel.apiKey);
          } catch (error) {
            logger.error('Error encrypting API key:', error);
            return res.status(500).json({ error: 'Failed to encrypt API key' });
          }
        } else {
          // Masked value - need to preserve existing key
          // CRITICAL FIX: Read from disk, not cache, to ensure we have the apiKey field
          // The cache might not have the apiKey due to TTL expiration or race conditions
          const rootDir = getRootDir();
          const modelFilePath = join(rootDir, 'contents', 'models', `${modelId}.json`);

          try {
            if (existsSync(modelFilePath)) {
              const existingModelFromDisk = JSON.parse(await fs.readFile(modelFilePath, 'utf8'));
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
            logger.error('Error reading existing model from disk:', error);
            // Fallback to removing the masked placeholder
            delete updatedModel.apiKey;
          }
        }
      }

      // Remove client-side helper fields
      delete updatedModel.apiKeySet;
      delete updatedModel.apiKeyMasked;

      if (updatedModel.default === true) {
        const modelsResponse = configCache.getModels(true);
        const allModels = modelsResponse.data || modelsResponse;
        for (const model of allModels) {
          if (model.id !== modelId && model.default === true) {
            const otherModelPath = join(getRootDir(), 'contents', 'models', `${model.id}.json`);
            model.default = false;
            await fs.writeFile(otherModelPath, JSON.stringify(model, null, 2));
          }
        }
      }
      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${modelId}.json`);
      await fs.writeFile(modelFilePath, JSON.stringify(updatedModel, null, 2));
      await configCache.refreshModelsCache();
      res.json({ message: 'Model updated successfully', model: updatedModel });
    } catch (error) {
      logger.error({
        component: 'ModelsRoutes',
        message: 'Error updating model',
        modelId: req.params.modelId,
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Failed to update model' });
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
        return res.status(400).json({ error: 'Missing required fields' });
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
          logger.error('Error encrypting API key:', error);
          return res.status(500).json({ error: 'Failed to encrypt API key' });
        }
      } else if (newModel.apiKey === '••••••••') {
        // Remove masked placeholder if no real key
        delete newModel.apiKey;
      }

      // Remove client-side helper fields
      delete newModel.apiKeySet;
      delete newModel.apiKeyMasked;

      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${newModel.id}.json`);
      try {
        readFileSync(modelFilePath, 'utf8');
        return res.status(409).json({ error: 'Model with this ID already exists' });
      } catch {
        // file not found, continue
      }
      if (newModel.default === true) {
        const modelsResponse = configCache.getModels(true);
        const allModels = modelsResponse.data || modelsResponse;
        for (const model of allModels) {
          if (model.default === true) {
            const otherModelPath = join(getRootDir(), 'contents', 'models', `${model.id}.json`);
            model.default = false;
            await fs.writeFile(otherModelPath, JSON.stringify(model, null, 2));
          }
        }
      }
      await fs.writeFile(modelFilePath, JSON.stringify(newModel, null, 2));
      await configCache.refreshModelsCache();
      res.json({ message: 'Model created successfully', model: newModel });
    } catch (error) {
      logger.error({
        component: 'ModelsRoutes',
        message: 'Error creating model',
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Failed to create model' });
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
        return res.status(404).json({ error: 'Model not found' });
      }
      const newEnabledState = !model.enabled;
      model.enabled = newEnabledState;
      if (!newEnabledState && model.default === true) {
        const enabledModels = models.filter(m => m.id !== modelId && m.enabled === true);
        if (enabledModels.length > 0) {
          enabledModels[0].default = true;
          const newDefaultPath = join(
            getRootDir(),
            'contents',
            'models',
            `${enabledModels[0].id}.json`
          );
          await fs.writeFile(newDefaultPath, JSON.stringify(enabledModels[0], null, 2));
        }
        model.default = false;
      }
      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${modelId}.json`);
      await fs.writeFile(modelFilePath, JSON.stringify(model, null, 2));
      await configCache.refreshModelsCache();
      res.json({
        message: `Model ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
        model: model,
        enabled: newEnabledState
      });
    } catch (error) {
      logger.error('Error toggling model:', error);
      res.status(500).json({ error: 'Failed to toggle model' });
    }
  });

  app.post(buildServerPath('/api/admin/models/:modelIds/_toggle'), adminAuth, async (req, res) => {
    try {
      const { modelIds } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Missing enabled flag' });
      }

      // Validate modelIds for security
      const ids = validateIdsForPath(modelIds, 'model', res);
      if (!ids) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const resolvedIds = ids.includes('*') ? models.map(m => m.id) : ids;
      const rootDir = getRootDir();

      for (const id of resolvedIds) {
        const model = models.find(m => m.id === id);
        if (!model) continue;
        model.enabled = enabled;
        if (!enabled) {
          model.default = false;
        }
        const modelFilePath = join(rootDir, 'contents', 'models', `${id}.json`);
        await fs.writeFile(modelFilePath, JSON.stringify(model, null, 2));
      }

      // ensure at least one enabled model has default=true
      const enabledModels = models.filter(m => m.enabled);
      if (enabledModels.length > 0 && !enabledModels.some(m => m.default)) {
        enabledModels[0].default = true;
        const defaultPath = join(rootDir, 'contents', 'models', `${enabledModels[0].id}.json`);
        await fs.writeFile(defaultPath, JSON.stringify(enabledModels[0], null, 2));
      }

      await configCache.refreshModelsCache();
      res.json({
        message: `Models ${enabled ? 'enabled' : 'disabled'} successfully`,
        enabled,
        ids: resolvedIds
      });
    } catch (error) {
      logger.error('Error toggling models:', error);
      res.status(500).json({ error: 'Failed to toggle models' });
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
        return res.status(404).json({ error: 'Model not found' });
      }
      if (model.default === true) {
        const otherModels = models.filter(m => m.id !== modelId && m.enabled === true);
        if (otherModels.length > 0) {
          otherModels[0].default = true;
          const newDefaultPath = join(
            getRootDir(),
            'contents',
            'models',
            `${otherModels[0].id}.json`
          );
          await fs.writeFile(newDefaultPath, JSON.stringify(otherModels[0], null, 2));
        }
      }
      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${modelId}.json`);
      if (!existsSync(modelFilePath)) {
        return res.status(404).json({ error: 'Model file not found' });
      }
      await fs.unlink(modelFilePath);
      await configCache.refreshModelsCache();
      await removeMarketplaceInstallation('model', modelId);
      res.json({ message: 'Model deleted successfully' });
    } catch (error) {
      logger.error('Error deleting model:', error);
      res.status(500).json({ error: 'Failed to delete model' });
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
        return res.status(404).json({ error: 'Model not found' });
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
        logger.error('Model test failed:', testError);
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
        res.status(500).json({
          success: false,
          message: userMessage,
          error: errorMessage,
          model: model
        });
      }
    } catch (error) {
      logger.error('Error testing model:', error);
      res.status(500).json({
        success: false,
        message: 'System error',
        error: 'Failed to test model due to a system error. Please try again.'
      });
    }
  });
}
