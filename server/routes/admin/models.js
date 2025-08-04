import { readFileSync, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { getLocalizedContent } from '../../../shared/localize.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';

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
  app.get('/api/admin/models', adminAuth, async (req, res) => {
    try {
      const { data: models, etag: modelsEtag } = configCache.getModels(true);
      res.setHeader('ETag', modelsEtag);
      res.json(models);
    } catch (error) {
      console.error('Error fetching all models:', error);
      res.status(500).json({ error: 'Failed to fetch models' });
    }
  });

  app.get('/api/admin/models/:modelId', adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;
      const { data: models, etag: modelsEtag } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }
      res.setHeader('ETag', modelsEtag);
      res.json(model);
    } catch (error) {
      console.error('Error fetching model:', error);
      res.status(500).json({ error: 'Failed to fetch model' });
    }
  });

  app.put('/api/admin/models/:modelId', adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;
      const updatedModel = req.body;
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
      if (updatedModel.default === true) {
        const allModels = configCache.getModels(true);
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
      console.error('Error updating model:', error);
      res.status(500).json({ error: 'Failed to update model' });
    }
  });

  app.post('/api/admin/models', adminAuth, async (req, res) => {
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
      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${newModel.id}.json`);
      try {
        readFileSync(modelFilePath, 'utf8');
        return res.status(409).json({ error: 'Model with this ID already exists' });
      } catch {
        // file not found, continue
      }
      if (newModel.default === true) {
        const allModels = configCache.getModels(true);
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
      console.error('Error creating model:', error);
      res.status(500).json({ error: 'Failed to create model' });
    }
  });

  app.post('/api/admin/models/:modelId/toggle', adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;
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
      console.error('Error toggling model:', error);
      res.status(500).json({ error: 'Failed to toggle model' });
    }
  });

  app.post('/api/admin/models/:modelIds/_toggle', adminAuth, async (req, res) => {
    try {
      const { modelIds } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Missing enabled flag' });
      }

      const { data: models } = configCache.getModels(true);
      const ids = modelIds === '*' ? models.map(m => m.id) : modelIds.split(',');
      const rootDir = getRootDir();

      for (const id of ids) {
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
        ids
      });
    } catch (error) {
      console.error('Error toggling models:', error);
      res.status(500).json({ error: 'Failed to toggle models' });
    }
  });

  app.delete('/api/admin/models/:modelId', adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;
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
      res.json({ message: 'Model deleted successfully' });
    } catch (error) {
      console.error('Error deleting model:', error);
      res.status(500).json({ error: 'Failed to delete model' });
    }
  });

  app.post('/api/admin/models/:modelId/test', adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;
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
        const result = await simpleCompletion(testMessage, { modelId: model.id });
        res.json({
          success: true,
          message: 'Model test successful',
          response: result.content,
          model: model
        });
      } catch (testError) {
        console.error('Model test failed:', testError);
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
      console.error('Error testing model:', error);
      res.status(500).json({
        success: false,
        message: 'System error',
        error: 'Failed to test model due to a system error. Please try again.'
      });
    }
  });
}
