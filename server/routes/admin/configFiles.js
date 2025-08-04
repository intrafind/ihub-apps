import { promises as fs } from 'fs';
import { join } from 'path';
import multer from 'multer';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { createSchemaValidator } from '../../utils/resourceLoader.js';
import { appConfigSchema } from '../../validators/appConfigSchema.js';
import { modelConfigSchema } from '../../validators/modelConfigSchema.js';
import { promptConfigSchema } from '../../validators/promptConfigSchema.js';

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for config files
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only JSON files are allowed'), false);
    }
  }
});

// Validation schemas for different config types
const configValidators = {
  apps: createSchemaValidator(appConfigSchema, {}),
  models: createSchemaValidator(modelConfigSchema, {}),
  prompts: createSchemaValidator(promptConfigSchema, {})
};

// Supported config types
const SUPPORTED_CONFIG_TYPES = ['apps', 'models', 'prompts'];

export default function registerAdminConfigFilesRoutes(app) {
  /**
   * Download config file for a specific type
   * GET /api/admin/config-files/:type/download
   */
  app.get('/api/admin/config-files/:type/download', adminAuth, async (req, res) => {
    try {
      const { type } = req.params;

      if (!SUPPORTED_CONFIG_TYPES.includes(type)) {
        return res.status(400).json({
          error: `Unsupported config type. Supported types: ${SUPPORTED_CONFIG_TYPES.join(', ')}`
        });
      }

      let data;
      let filename;

      switch (type) {
        case 'apps':
          const { data: apps } = configCache.getApps(true);
          data = apps || [];
          filename = 'apps.json';
          break;
        case 'models':
          const { data: models } = configCache.getModels(true);
          data = models || [];
          filename = 'models.json';
          break;
        case 'prompts':
          const { data: prompts } = configCache.getPrompts(true);
          data = prompts || [];
          filename = 'prompts.json';
          break;
      }

      // Set appropriate headers for file download
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-cache');

      res.json(data);
    } catch (error) {
      console.error(`Error downloading ${req.params.type} config:`, error);
      res.status(500).json({ error: `Failed to download ${req.params.type} configuration` });
    }
  });

  /**
   * Upload and replace config file for a specific type
   * POST /api/admin/config-files/:type/upload
   */
  app.post(
    '/api/admin/config-files/:type/upload',
    adminAuth,
    upload.single('config'),
    async (req, res) => {
      try {
        const { type } = req.params;
        const { replace = false } = req.body;

        if (!SUPPORTED_CONFIG_TYPES.includes(type)) {
          return res.status(400).json({
            error: `Unsupported config type. Supported types: ${SUPPORTED_CONFIG_TYPES.join(', ')}`
          });
        }

        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }

        // Parse uploaded JSON
        let uploadedData;
        try {
          uploadedData = JSON.parse(req.file.buffer.toString('utf8'));
        } catch (parseError) {
          return res.status(400).json({ error: 'Invalid JSON format' });
        }

        // Validate that uploaded data is an array
        if (!Array.isArray(uploadedData)) {
          return res.status(400).json({ error: 'Config file must contain an array of items' });
        }

        // Validate each item in the array
        const validator = configValidators[type];
        const validationErrors = [];

        for (let i = 0; i < uploadedData.length; i++) {
          const item = uploadedData[i];
          const validation = validator(item);

          if (!validation.isValid) {
            validationErrors.push({
              index: i,
              id: item.id || `item-${i}`,
              errors: validation.errors
            });
          }
        }

        if (validationErrors.length > 0) {
          return res.status(400).json({
            error: 'Validation failed for uploaded items',
            validationErrors: validationErrors
          });
        }

        // Check for duplicate IDs within the uploaded data
        const ids = new Set();
        const duplicates = [];

        for (const item of uploadedData) {
          if (ids.has(item.id)) {
            duplicates.push(item.id);
          } else {
            ids.add(item.id);
          }
        }

        if (duplicates.length > 0) {
          return res.status(400).json({
            error: 'Duplicate IDs found in uploaded data',
            duplicates: duplicates
          });
        }

        let finalData;
        let conflictingIds = [];

        if (replace) {
          // Replace mode: use uploaded data as-is
          finalData = uploadedData;
        } else {
          // Merge mode: combine with existing data, checking for conflicts
          let existingData;

          switch (type) {
            case 'apps':
              const { data: apps } = configCache.getApps(true);
              existingData = apps || [];
              break;
            case 'models':
              const { data: models } = configCache.getModels(true);
              existingData = models || [];
              break;
            case 'prompts':
              const { data: prompts } = configCache.getPrompts(true);
              existingData = prompts || [];
              break;
          }

          // Check for ID conflicts
          const existingIds = new Set(existingData.map(item => item.id));
          const uploadedIds = new Set(uploadedData.map(item => item.id));

          conflictingIds = [...uploadedIds].filter(id => existingIds.has(id));

          if (conflictingIds.length > 0) {
            return res.status(409).json({
              error: 'ID conflicts detected. Items with these IDs already exist',
              conflictingIds: conflictingIds,
              message: 'Use replace=true to overwrite existing configuration'
            });
          }

          // Merge data
          finalData = [...existingData, ...uploadedData];
        }

        // Write to appropriate config file
        const rootDir = getRootDir();
        const configPath = join(rootDir, 'contents', 'config', `${type}.json`);

        await atomicWriteJSON(configPath, finalData);

        // Refresh the appropriate cache
        switch (type) {
          case 'apps':
            await configCache.refreshAppsCache();
            break;
          case 'models':
            await configCache.refreshModelsCache();
            break;
          case 'prompts':
            await configCache.refreshPromptsCache();
            break;
        }

        const result = {
          message: `${type} configuration uploaded successfully`,
          uploaded: uploadedData.length,
          total: finalData.length,
          mode: replace ? 'replace' : 'merge'
        };

        if (conflictingIds.length > 0) {
          result.conflictingIds = conflictingIds;
        }

        console.log(
          `✅ ${type} configuration uploaded: ${uploadedData.length} items (${result.mode} mode)`
        );

        res.json(result);
      } catch (error) {
        console.error(`Error uploading ${req.params.type} config:`, error);
        res.status(500).json({ error: `Failed to upload ${req.params.type} configuration` });
      }
    }
  );

  /**
   * Get config file info and statistics
   * GET /api/admin/config-files/:type/info
   */
  app.get('/api/admin/config-files/:type/info', adminAuth, async (req, res) => {
    try {
      const { type } = req.params;

      if (!SUPPORTED_CONFIG_TYPES.includes(type)) {
        return res.status(400).json({
          error: `Unsupported config type. Supported types: ${SUPPORTED_CONFIG_TYPES.join(', ')}`
        });
      }

      let data;
      let configPath;
      const rootDir = getRootDir();

      switch (type) {
        case 'apps':
          const { data: apps } = configCache.getApps(true);
          data = apps || [];
          configPath = join(rootDir, 'contents', 'config', 'apps.json');
          break;
        case 'models':
          const { data: models } = configCache.getModels(true);
          data = models || [];
          configPath = join(rootDir, 'contents', 'config', 'models.json');
          break;
        case 'prompts':
          const { data: prompts } = configCache.getPrompts(true);
          data = prompts || [];
          configPath = join(rootDir, 'contents', 'config', 'prompts.json');
          break;
      }

      // Get file stats if file exists
      let fileStats = null;
      try {
        const stats = await fs.stat(configPath);
        fileStats = {
          size: stats.size,
          modified: stats.mtime,
          created: stats.birthtime
        };
      } catch (error) {
        // File doesn't exist yet
      }

      const info = {
        type: type,
        totalItems: data.length,
        enabledItems: data.filter(item => item.enabled !== false).length,
        disabledItems: data.filter(item => item.enabled === false).length,
        fileExists: fileStats !== null,
        fileStats: fileStats,
        configPath: `contents/config/${type}.json`
      };

      res.json(info);
    } catch (error) {
      console.error(`Error getting ${req.params.type} config info:`, error);
      res.status(500).json({ error: `Failed to get ${req.params.type} configuration info` });
    }
  });

  /**
   * Backup current config before upload
   * POST /api/admin/config-files/:type/backup
   */
  app.post('/api/admin/config-files/:type/backup', adminAuth, async (req, res) => {
    try {
      const { type } = req.params;

      if (!SUPPORTED_CONFIG_TYPES.includes(type)) {
        return res.status(400).json({
          error: `Unsupported config type. Supported types: ${SUPPORTED_CONFIG_TYPES.join(', ')}`
        });
      }

      const rootDir = getRootDir();
      const configPath = join(rootDir, 'contents', 'config', `${type}.json`);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(rootDir, 'contents', 'config', `${type}.backup.${timestamp}.json`);

      // Check if original file exists
      let fileExists = false;
      try {
        await fs.access(configPath);
        fileExists = true;
      } catch (error) {
        // File doesn't exist, nothing to backup
      }

      if (!fileExists) {
        return res.json({
          message: `No existing ${type} configuration to backup`,
          backed_up: false
        });
      }

      // Create backup
      const configData = await fs.readFile(configPath, 'utf8');
      await fs.writeFile(backupPath, configData, 'utf8');

      console.log(`📦 Created backup: ${backupPath}`);

      res.json({
        message: `${type} configuration backed up successfully`,
        backupPath: `contents/config/${type}.backup.${timestamp}.json`,
        backed_up: true
      });
    } catch (error) {
      console.error(`Error creating ${req.params.type} config backup:`, error);
      res.status(500).json({ error: `Failed to create ${req.params.type} configuration backup` });
    }
  });
}
