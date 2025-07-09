import { getUsage } from '../usageTracker.js';
import configCache from '../configCache.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';

export default function registerAdminRoutes(app) {
  app.get('/api/admin/usage', async (req, res) => {
    try {
      const data = await getUsage();
      res.json(data);
    } catch (e) {
      console.error('Error loading usage data:', e);
      res.status(500).json({ error: 'Failed to load usage data' });
    }
  });

  // Configuration cache management endpoints
  app.get('/api/admin/cache/stats', async (req, res) => {
    try {
      const stats = configCache.getStats();
      res.json(stats);
    } catch (e) {
      console.error('Error getting cache stats:', e);
      res.status(500).json({ error: 'Failed to get cache statistics' });
    }
  });
  // Support both POST and GET for cache refresh
  app.post('/api/admin/cache/_refresh', async (req, res) => {
    try {
      await configCache.refreshAll();
      res.json({ message: 'Configuration cache refreshed successfully' });
    } catch (e) {
      console.error('Error refreshing cache:', e);
      res.status(500).json({ error: 'Failed to refresh cache' });
    }
  });

  app.get('/api/admin/cache/_refresh', (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  // Support both POST and GET for cache clear
  app.post('/api/admin/cache/_clear', async (req, res) => {
    try {
      configCache.clear();
      res.json({ message: 'Configuration cache cleared successfully' });
    } catch (e) {
      console.error('Error clearing cache:', e);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  });

  app.get('/api/admin/cache/_clear', (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  // Force refresh endpoint - triggers client reload by updating refresh salt
  app.post('/api/admin/client/_refresh', async (req, res) => {
    try {
      const rootDir = getRootDir();
      const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');
      
      // Read current platform config
      const platformConfig = JSON.parse(readFileSync(platformConfigPath, 'utf8'));
      
      // Initialize refreshSalt if it doesn't exist
      if (!platformConfig.refreshSalt) {
        platformConfig.refreshSalt = {
          salt: 0,
          lastUpdated: new Date().toISOString()
        };
      }
      
      // Increment admin-triggered value and update timestamp
      platformConfig.refreshSalt.salt += 1;
      platformConfig.refreshSalt.lastUpdated = new Date().toISOString();
      
      // Write back to file
      writeFileSync(platformConfigPath, JSON.stringify(platformConfig, null, 2));
      
      // Small delay to ensure file write is complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Refresh specifically the platform configuration
      await configCache.refreshCacheEntry('config/platform.json');
      
      console.log(`🔄 Force refresh triggered. New admin salt: ${platformConfig.refreshSalt.salt}`);
      
      res.json({ 
        message: 'Force refresh triggered successfully',
        newAdminSalt: platformConfig.refreshSalt.salt,
        timestamp: platformConfig.refreshSalt.lastUpdated
      });
    } catch (error) {
      console.error('Error triggering force refresh:', error);
      res.status(500).json({ error: 'Failed to trigger force refresh' });
    }
  });

  app.get('/api/admin/client/_refresh', (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  // Apps management endpoints
  app.get('/api/admin/apps', async (req, res) => {
    try {
      const apps = configCache.getApps(true);
      res.json(apps);
    } catch (error) {
      console.error('Error fetching all apps:', error);
      res.status(500).json({ error: 'Failed to fetch apps' });
    }
  });

  app.get('/api/admin/apps/:appId', async (req, res) => {
    try {
      const { appId } = req.params;
      const apps = configCache.getApps(true);
      const app = apps.find(a => a.id === appId);
      
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }
      
      res.json(app);
    } catch (error) {
      console.error('Error fetching app:', error);
      res.status(500).json({ error: 'Failed to fetch app' });
    }
  });

  app.put('/api/admin/apps/:appId', async (req, res) => {
    try {
      const { appId } = req.params;
      const updatedApp = req.body;
      
      // Validate required fields
      if (!updatedApp.id || !updatedApp.name || !updatedApp.description) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // Ensure the ID matches
      if (updatedApp.id !== appId) {
        return res.status(400).json({ error: 'App ID cannot be changed' });
      }
      
      // Save the app to individual file
      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${appId}.json`);
      
      writeFileSync(appFilePath, JSON.stringify(updatedApp, null, 2));
      
      // Refresh the apps cache
      await configCache.refreshAppsCache();
      
      res.json({ message: 'App updated successfully', app: updatedApp });
    } catch (error) {
      console.error('Error updating app:', error);
      res.status(500).json({ error: 'Failed to update app' });
    }
  });

  app.post('/api/admin/apps', async (req, res) => {
    try {
      const newApp = req.body;
      
      // Validate required fields
      if (!newApp.id || !newApp.name || !newApp.description) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // Check if app with this ID already exists
      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${newApp.id}.json`);
      
      try {
        readFileSync(appFilePath, 'utf8');
        return res.status(400).json({ error: 'App with this ID already exists' });
      } catch (err) {
        // File doesn't exist, which is what we want
      }
      
      // Save the app to individual file
      writeFileSync(appFilePath, JSON.stringify(newApp, null, 2));
      
      // Refresh the apps cache
      await configCache.refreshAppsCache();
      
      res.json({ message: 'App created successfully', app: newApp });
    } catch (error) {
      console.error('Error creating app:', error);
      res.status(500).json({ error: 'Failed to create app' });
    }
  });

  app.post('/api/admin/apps/:appId/toggle', async (req, res) => {
    try {
      const { appId } = req.params;
      const apps = configCache.getApps(true);
      const app = apps.find(a => a.id === appId);
      
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }
      
      // Toggle the enabled state
      const newEnabledState = !app.enabled;
      app.enabled = newEnabledState;
      
      // Save the app to individual file
      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${appId}.json`);
      
      writeFileSync(appFilePath, JSON.stringify(app, null, 2));
      
      // Refresh the apps cache
      await configCache.refreshAppsCache();
      
      res.json({ 
        message: `App ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
        app: app,
        enabled: newEnabledState 
      });
    } catch (error) {
      console.error('Error toggling app:', error);
      res.status(500).json({ error: 'Failed to toggle app' });
    }
  });

  app.delete('/api/admin/apps/:appId', async (req, res) => {
    try {
      const { appId } = req.params;
      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${appId}.json`);
      
      // Check if file exists
      if (!readFileSync(appFilePath, 'utf8')) {
        return res.status(404).json({ error: 'App not found' });
      }
      
      // Delete the file
      require('fs').unlinkSync(appFilePath);
      
      // Refresh the apps cache
      await configCache.refreshAppsCache();
      
      res.json({ message: 'App deleted successfully' });
    } catch (error) {
      console.error('Error deleting app:', error);
      res.status(500).json({ error: 'Failed to delete app' });
    }
  });

  // Models management endpoints
  app.get('/api/admin/models', async (req, res) => {
    try {
      const models = configCache.getModels(true);
      res.json(models);
    } catch (error) {
      console.error('Error fetching all models:', error);
      res.status(500).json({ error: 'Failed to fetch models' });
    }
  });

  app.get('/api/admin/models/:modelId', async (req, res) => {
    try {
      const { modelId } = req.params;
      const models = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }
      
      res.json(model);
    } catch (error) {
      console.error('Error fetching model:', error);
      res.status(500).json({ error: 'Failed to fetch model' });
    }
  });

  app.put('/api/admin/models/:modelId', async (req, res) => {
    try {
      const { modelId } = req.params;
      const updatedModel = req.body;
      
      // Validate required fields
      if (!updatedModel.id || !updatedModel.name || !updatedModel.description || !updatedModel.provider) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // Ensure the ID matches
      if (updatedModel.id !== modelId) {
        return res.status(400).json({ error: 'Model ID cannot be changed' });
      }
      
      // Handle default model logic - only one model can be default
      if (updatedModel.default === true) {
        // Get all models and remove default from others
        const allModels = configCache.getModels(true);
        for (const model of allModels) {
          if (model.id !== modelId && model.default === true) {
            // Remove default from other models
            const otherModelPath = join(getRootDir(), 'contents', 'models', `${model.id}.json`);
            model.default = false;
            writeFileSync(otherModelPath, JSON.stringify(model, null, 2));
          }
        }
      }
      
      // Save the model to individual file
      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${modelId}.json`);
      
      writeFileSync(modelFilePath, JSON.stringify(updatedModel, null, 2));
      
      // Refresh the models cache
      await configCache.refreshModelsCache();
      
      res.json({ message: 'Model updated successfully', model: updatedModel });
    } catch (error) {
      console.error('Error updating model:', error);
      res.status(500).json({ error: 'Failed to update model' });
    }
  });

  app.post('/api/admin/models', async (req, res) => {
    try {
      const newModel = req.body;
      
      // Validate required fields
      if (!newModel.id || !newModel.name || !newModel.description || !newModel.provider) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // Check if model with this ID already exists
      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${newModel.id}.json`);
      
      try {
        readFileSync(modelFilePath, 'utf8');
        return res.status(400).json({ error: 'Model with this ID already exists' });
      } catch (err) {
        // File doesn't exist, which is what we want
      }
      
      // Handle default model logic - only one model can be default
      if (newModel.default === true) {
        // Get all models and remove default from others
        const allModels = configCache.getModels(true);
        for (const model of allModels) {
          if (model.default === true) {
            // Remove default from other models
            const otherModelPath = join(getRootDir(), 'contents', 'models', `${model.id}.json`);
            model.default = false;
            writeFileSync(otherModelPath, JSON.stringify(model, null, 2));
          }
        }
      }
      
      // Save the model to individual file
      writeFileSync(modelFilePath, JSON.stringify(newModel, null, 2));
      
      // Refresh the models cache
      await configCache.refreshModelsCache();
      
      res.json({ message: 'Model created successfully', model: newModel });
    } catch (error) {
      console.error('Error creating model:', error);
      res.status(500).json({ error: 'Failed to create model' });
    }
  });

  app.post('/api/admin/models/:modelId/toggle', async (req, res) => {
    try {
      const { modelId } = req.params;
      const models = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }
      
      // Toggle the enabled state
      const newEnabledState = !model.enabled;
      model.enabled = newEnabledState;
      
      // If disabling the default model, we need to set another as default
      if (!newEnabledState && model.default === true) {
        const enabledModels = models.filter(m => m.id !== modelId && m.enabled === true);
        if (enabledModels.length > 0) {
          enabledModels[0].default = true;
          // Save the new default model
          const newDefaultPath = join(getRootDir(), 'contents', 'models', `${enabledModels[0].id}.json`);
          writeFileSync(newDefaultPath, JSON.stringify(enabledModels[0], null, 2));
        }
        model.default = false;
      }
      
      // Save the model to individual file
      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${modelId}.json`);
      
      writeFileSync(modelFilePath, JSON.stringify(model, null, 2));
      
      // Refresh the models cache
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

  app.delete('/api/admin/models/:modelId', async (req, res) => {
    try {
      const { modelId } = req.params;
      const models = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }
      
      // If deleting the default model, set another as default
      if (model.default === true) {
        const otherModels = models.filter(m => m.id !== modelId && m.enabled === true);
        if (otherModels.length > 0) {
          otherModels[0].default = true;
          // Save the new default model
          const newDefaultPath = join(getRootDir(), 'contents', 'models', `${otherModels[0].id}.json`);
          writeFileSync(newDefaultPath, JSON.stringify(otherModels[0], null, 2));
        }
      }
      
      const rootDir = getRootDir();
      const modelFilePath = join(rootDir, 'contents', 'models', `${modelId}.json`);
      
      // Check if file exists
      if (!existsSync(modelFilePath)) {
        return res.status(404).json({ error: 'Model file not found' });
      }
      
      // Delete the file
      require('fs').unlinkSync(modelFilePath);
      
      // Refresh the models cache
      await configCache.refreshModelsCache();
      
      res.json({ message: 'Model deleted successfully' });
    } catch (error) {
      console.error('Error deleting model:', error);
      res.status(500).json({ error: 'Failed to delete model' });
    }
  });

  // Model testing endpoint
  app.post('/api/admin/models/:modelId/test', async (req, res) => {
    try {
      const { modelId } = req.params;
      const models = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      
      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }
      
      // Simple test - try to make a basic request to the model
      const testMessage = 'Hello, can you respond with a simple "Test successful" message?';
      
      // Import the utils for model testing
      const { simpleCompletion } = await import('../utils.js');
      
      try {
        console.log('Testing model:', model);
        const response = await simpleCompletion(testMessage, {modelId: model.id});
        res.json({ 
          success: true, 
          message: 'Model test successful',
          response: response,
          model: model
        });
      } catch (testError) {
        console.error('Model test failed:', testError);
        
        // Provide more detailed error messages based on the error type
        let errorMessage = 'Unknown error occurred';
        let userMessage = 'Model test failed';
        
        if (testError.message.includes('fetch failed')) {
          if (testError.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
            userMessage = 'Connection timeout';
            errorMessage = 'The model service did not respond within the timeout period. Please check if the model URL is correct and the service is running.';
          } else if (testError.cause?.code === 'ECONNREFUSED') {
            userMessage = 'Connection refused';
            errorMessage = 'Unable to connect to the model service. Please verify the URL and ensure the service is running.';
          } else if (testError.cause?.code === 'ENOTFOUND') {
            userMessage = 'Service not found';
            errorMessage = 'The model service hostname could not be resolved. Please check the URL configuration.';
          } else {
            userMessage = 'Network error';
            errorMessage = `Network connection failed: ${testError.cause?.message || testError.message}`;
          }
        } else if (testError.message.includes('timeout')) {
          userMessage = 'Request timeout';
          errorMessage = 'The model service took too long to respond. Please try again or check the service status.';
        } else if (testError.message.includes('401')) {
          userMessage = 'Authentication failed';
          errorMessage = 'Invalid API key or authentication credentials. Please check your model configuration.';
        } else if (testError.message.includes('403')) {
          userMessage = 'Access denied';
          errorMessage = 'Access denied by the model service. Please check your API key permissions.';
        } else if (testError.message.includes('404')) {
          userMessage = 'Model not found';
          errorMessage = 'The specified model was not found on the service. Please check the model ID configuration.';
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
