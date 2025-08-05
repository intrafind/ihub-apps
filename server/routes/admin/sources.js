import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import {
  validateSourceConfig,
  validateSourcesArray,
  getDefaultSourceConfig
} from '../../validators/sourceConfigSchema.js';
import SourceManager from '../../sources/SourceManager.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';

let sourceManager = null;

/**
 * Initialize source manager singleton
 * @returns {SourceManager} Source manager instance
 */
function getSourceManager() {
  if (!sourceManager) {
    sourceManager = new SourceManager();
  }
  return sourceManager;
}

/**
 * Register all sources administration routes
 * @param {Express} app - Express application instance
 */
export default function registerAdminSourcesRoutes(app) {
  // GET /api/admin/sources - List all sources
  app.get('/api/admin/sources', adminAuth, async (req, res) => {
    try {
      const { data: sources, etag } = configCache.getSources(true);
      res.setHeader('ETag', etag);
      res.json(sources);
    } catch (error) {
      sendFailedOperationError(res, 'fetch sources', error);
    }
  });

  // GET /api/admin/sources/:id - Get specific source
  app.get('/api/admin/sources/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { data: sources } = configCache.getSources(true);
      const source = sources.find(s => s.id === id);

      if (!source) {
        return sendNotFound(res, 'Source');
      }

      res.json(source);
    } catch (error) {
      sendFailedOperationError(res, 'fetch source', error);
    }
  });

  // POST /api/admin/sources - Create new source
  app.post('/api/admin/sources', adminAuth, async (req, res) => {
    try {
      const sourceData = req.body;

      // Validate source configuration
      const validation = validateSourceConfig(sourceData);
      if (!validation.success) {
        return sendBadRequest(res, 'Invalid source configuration', validation.errors);
      }

      const newSource = validation.data;

      // Check for duplicate ID
      const { data: existingSources } = configCache.getSources(true);
      if (existingSources.some(s => s.id === newSource.id)) {
        return sendBadRequest(res, 'Source ID already exists');
      }

      // Add creation timestamp
      newSource.created = new Date().toISOString();

      // Update sources file
      const updatedSources = [...existingSources, newSource];
      await saveSourcesConfig(updatedSources);

      // Refresh cache
      await configCache.refreshSourcesCache();

      res.json({ message: 'Source created successfully', source: newSource });
    } catch (error) {
      sendFailedOperationError(res, 'create source', error);
    }
  });

  // PUT /api/admin/sources/:id - Update source
  app.put('/api/admin/sources/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const sourceData = req.body;

      // Ensure ID matches
      if (sourceData.id !== id) {
        return sendBadRequest(res, 'Source ID mismatch');
      }

      // Validate source configuration
      const validation = validateSourceConfig(sourceData);
      if (!validation.success) {
        return sendBadRequest(res, 'Invalid source configuration', validation.errors);
      }

      const updatedSource = validation.data;

      // Find existing source
      const { data: sources } = configCache.getSources(true);
      const existingIndex = sources.findIndex(s => s.id === id);

      if (existingIndex === -1) {
        return sendNotFound(res, 'Source');
      }

      // Preserve creation timestamp
      updatedSource.created = sources[existingIndex].created;

      // Update sources array
      const updatedSources = [...sources];
      updatedSources[existingIndex] = updatedSource;

      await saveSourcesConfig(updatedSources);
      await configCache.refreshSourcesCache();

      res.json({ message: 'Source updated successfully', source: updatedSource });
    } catch (error) {
      sendFailedOperationError(res, 'update source', error);
    }
  });

  // DELETE /api/admin/sources/:id - Delete source
  app.delete('/api/admin/sources/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { data: sources } = configCache.getSources(true);
      const sourceIndex = sources.findIndex(s => s.id === id);

      if (sourceIndex === -1) {
        return sendNotFound(res, 'Source');
      }

      // Check for dependencies (apps using this source)
      const dependencies = await findSourceDependencies(id);
      if (dependencies.length > 0) {
        return sendBadRequest(res, 'Cannot delete source with dependencies', {
          dependencies: dependencies.map(dep => ({ appId: dep.id, appName: dep.name }))
        });
      }

      // Remove source
      const updatedSources = sources.filter(s => s.id !== id);
      await saveSourcesConfig(updatedSources);
      await configCache.refreshSourcesCache();

      res.json({ message: 'Source deleted successfully' });
    } catch (error) {
      sendFailedOperationError(res, 'delete source', error);
    }
  });

  // POST /api/admin/sources/:id/test - Test source connection
  app.post('/api/admin/sources/:id/test', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { data: sources } = configCache.getSources(true);
      const source = sources.find(s => s.id === id);

      if (!source) {
        return sendNotFound(res, 'Source');
      }

      const manager = getSourceManager();
      const startTime = Date.now();

      try {
        // Test source connection
        const result = await manager.testSource(source.type, source.config);
        const duration = Date.now() - startTime;

        res.json({
          success: true,
          result: {
            connected: true,
            duration,
            ...result
          }
        });
      } catch (testError) {
        const duration = Date.now() - startTime;
        res.status(400).json({
          success: false,
          error: testError.message,
          duration
        });
      }
    } catch (error) {
      sendFailedOperationError(res, 'test source', error);
    }
  });

  // POST /api/admin/sources/:id/preview - Preview source content
  app.post('/api/admin/sources/:id/preview', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { limit = 1000 } = req.query;
      const { data: sources } = configCache.getSources(true);
      const source = sources.find(s => s.id === id);

      if (!source) {
        return sendNotFound(res, 'Source');
      }

      const manager = getSourceManager();

      try {
        const content = await manager.loadContent(source.type, source.config);
        const preview = content.substring(0, parseInt(limit));

        res.json({
          success: true,
          preview,
          metadata: {
            totalLength: content.length,
            truncated: content.length > parseInt(limit),
            encoding: 'utf-8'
          }
        });
      } catch (previewError) {
        res.status(400).json({
          success: false,
          error: previewError.message
        });
      }
    } catch (error) {
      sendFailedOperationError(res, 'preview source', error);
    }
  });

  // POST /api/admin/sources/_toggle - Bulk toggle sources
  app.post('/api/admin/sources/_toggle', adminAuth, async (req, res) => {
    try {
      const { sourceIds, enabled } = req.body;

      if (!Array.isArray(sourceIds) || typeof enabled !== 'boolean') {
        return sendBadRequest(res, 'Invalid request format');
      }

      const { data: sources } = configCache.getSources(true);
      let updatedCount = 0;

      const updatedSources = sources.map(source => {
        if (sourceIds.includes(source.id)) {
          updatedCount++;
          return { ...source, enabled, updated: new Date().toISOString() };
        }
        return source;
      });

      await saveSourcesConfig(updatedSources);
      await configCache.refreshSourcesCache();

      res.json({ message: `${updatedCount} sources ${enabled ? 'enabled' : 'disabled'}` });
    } catch (error) {
      sendFailedOperationError(res, 'toggle sources', error);
    }
  });

  // GET /api/admin/sources/_stats - Get sources statistics
  app.get('/api/admin/sources/_stats', adminAuth, async (req, res) => {
    try {
      const { data: sources } = configCache.getSources(true);

      const stats = {
        total: sources.length,
        enabled: sources.filter(s => s.enabled !== false).length,
        disabled: sources.filter(s => s.enabled === false).length,
        byType: {
          filesystem: sources.filter(s => s.type === 'filesystem').length,
          url: sources.filter(s => s.type === 'url').length,
          ifinder: sources.filter(s => s.type === 'ifinder').length
        },
        byExposeAs: {
          prompt: sources.filter(s => s.exposeAs === 'prompt').length,
          tool: sources.filter(s => s.exposeAs === 'tool').length
        }
      };

      res.json(stats);
    } catch (error) {
      sendFailedOperationError(res, 'fetch source statistics', error);
    }
  });

  // GET /api/admin/sources/_types - Get available source types
  app.get('/api/admin/sources/_types', adminAuth, async (req, res) => {
    try {
      const manager = getSourceManager();
      const handlerTypes = manager.getHandlerTypes();

      const types = handlerTypes.map(type => ({
        id: type,
        name: type.charAt(0).toUpperCase() + type.slice(1),
        description: getTypeDescription(type),
        defaultConfig: getDefaultSourceConfig(type)
      }));

      res.json(types);
    } catch (error) {
      sendFailedOperationError(res, 'fetch source types', error);
    }
  });

  // GET /api/admin/sources/_dependencies/:id - Get source dependencies
  app.get('/api/admin/sources/_dependencies/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const dependencies = await findSourceDependencies(id);

      res.json({
        sourceId: id,
        dependencies: dependencies.map(dep => ({
          appId: dep.id,
          appName: Object.values(dep.name || {})[0] || dep.id,
          type: 'app'
        }))
      });
    } catch (error) {
      sendFailedOperationError(res, 'fetch source dependencies', error);
    }
  });

  // Filesystem source file operations

  // GET /api/admin/sources/:id/files - List files for filesystem source
  app.get('/api/admin/sources/:id/files', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { path = '' } = req.query;
      const { data: sources } = configCache.getSources(true);
      const source = sources.find(s => s.id === id);

      if (!source) {
        return sendNotFound(res, 'Source');
      }

      if (source.type !== 'filesystem') {
        return sendBadRequest(res, 'File operations only supported for filesystem sources');
      }

      const manager = getSourceManager();
      const handler = manager.getHandler('filesystem');

      try {
        const files = await handler.listFiles(path);
        const directories = await handler.listDirectories(path);

        res.json({
          success: true,
          path,
          files,
          directories
        });
      } catch (fileError) {
        res.status(400).json({
          success: false,
          error: fileError.message
        });
      }
    } catch (error) {
      sendFailedOperationError(res, 'list files', error);
    }
  });

  // GET /api/admin/sources/:id/files/content - Get file content for filesystem source
  app.get('/api/admin/sources/:id/files/content', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { path } = req.query;
      const { data: sources } = configCache.getSources(true);
      const source = sources.find(s => s.id === id);

      if (!source) {
        return sendNotFound(res, 'Source');
      }

      if (source.type !== 'filesystem') {
        return sendBadRequest(res, 'File operations only supported for filesystem sources');
      }

      if (!path) {
        return sendBadRequest(res, 'File path is required');
      }

      const manager = getSourceManager();
      const handler = manager.getHandler('filesystem');

      try {
        const result = await handler.loadContent({ path });

        res.json({
          success: true,
          content: result.content,
          metadata: result.metadata
        });
      } catch (fileError) {
        res.status(400).json({
          success: false,
          error: fileError.message
        });
      }
    } catch (error) {
      sendFailedOperationError(res, 'get file content', error);
    }
  });

  // POST /api/admin/sources/:id/files - Write file for filesystem source
  app.post('/api/admin/sources/:id/files', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { path, content, encoding = 'utf8' } = req.body;
      const { data: sources } = configCache.getSources(true);
      const source = sources.find(s => s.id === id);

      if (!source) {
        return sendNotFound(res, 'Source');
      }

      if (source.type !== 'filesystem') {
        return sendBadRequest(res, 'File operations only supported for filesystem sources');
      }

      if (!path || content === undefined) {
        return sendBadRequest(res, 'File path and content are required');
      }

      const manager = getSourceManager();
      const handler = manager.getHandler('filesystem');

      try {
        const result = await handler.writeFile(path, content, encoding);

        res.json({
          success: true,
          message: 'File written successfully',
          result
        });
      } catch (fileError) {
        res.status(400).json({
          success: false,
          error: fileError.message
        });
      }
    } catch (error) {
      sendFailedOperationError(res, 'write file', error);
    }
  });

  // DELETE /api/admin/sources/:id/files - Delete file for filesystem source
  app.delete('/api/admin/sources/:id/files', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { path } = req.query;
      const { data: sources } = configCache.getSources(true);
      const source = sources.find(s => s.id === id);

      if (!source) {
        return sendNotFound(res, 'Source');
      }

      if (source.type !== 'filesystem') {
        return sendBadRequest(res, 'File operations only supported for filesystem sources');
      }

      if (!path) {
        return sendBadRequest(res, 'File path is required');
      }

      const manager = getSourceManager();
      const handler = manager.getHandler('filesystem');

      try {
        const result = await handler.deleteFile(path);

        res.json({
          success: true,
          message: 'File deleted successfully',
          result
        });
      } catch (fileError) {
        res.status(400).json({
          success: false,
          error: fileError.message
        });
      }
    } catch (error) {
      sendFailedOperationError(res, 'delete file', error);
    }
  });
}

/**
 * Helper function to save sources configuration
 * @param {Array} sources - Array of source configurations
 */
async function saveSourcesConfig(sources) {
  const sourcesPath = join(getRootDir(), 'contents', 'config', 'sources.json');

  // Validate entire array
  const validation = validateSourcesArray(sources);
  if (!validation.success) {
    throw new Error(
      `Sources validation failed: ${validation.errors.map(e => e.message).join(', ')}`
    );
  }

  await atomicWriteJSON(sourcesPath, validation.data);
}

/**
 * Helper function to find source dependencies in apps
 * @param {string} sourceId - Source ID to search for
 * @returns {Promise<Array>} Array of apps using this source
 */
async function findSourceDependencies(sourceId) {
  try {
    const { data: apps } = configCache.getApps(true);
    const dependencies = [];

    for (const app of apps) {
      // Check if app references this source
      if (app.sources && Array.isArray(app.sources)) {
        const hasSourceReference = app.sources.some(sourceRef =>
          typeof sourceRef === 'string' ? sourceRef === sourceId : sourceRef.id === sourceId
        );
        if (hasSourceReference) {
          dependencies.push(app);
        }
      }

      // Check legacy source supplements
      if (app.sourceSupplements && Array.isArray(app.sourceSupplements)) {
        const hasLegacyReference = app.sourceSupplements.some(
          supplement => supplement.sourceId === sourceId
        );
        if (hasLegacyReference) {
          dependencies.push(app);
        }
      }
    }

    return dependencies;
  } catch (error) {
    console.error('Error finding source dependencies:', error);
    return [];
  }
}

/**
 * Get description for source type
 * @param {string} type - Source type
 * @returns {string} Type description
 */
function getTypeDescription(type) {
  const descriptions = {
    filesystem: 'Load content from local filesystem paths',
    url: 'Fetch content from web URLs',
    ifinder: 'Search and retrieve content from iFinder repositories'
  };

  return descriptions[type] || `${type} source handler`;
}
