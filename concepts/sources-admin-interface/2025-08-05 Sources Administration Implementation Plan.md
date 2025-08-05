# Sources Administration Feature - Comprehensive Implementation Plan

**Document Version:** 1.0  
**Created:** August 5, 2025  
**Status:** Ready for Implementation  
**Estimated Duration:** 4-5 weeks  
**Complexity:** Medium-High

## Executive Summary

This implementation plan provides a complete step-by-step guide for adding Sources Administration capabilities to AI Hub Apps. The feature will enable administrators to manage filesystem, URL, and iFinder sources through a comprehensive admin interface while maintaining full backward compatibility with existing app configurations.

## Prerequisites

Before starting implementation, ensure you have:

- Development environment set up with Node.js 18+
- AI Hub Apps running locally with admin access
- Understanding of existing admin patterns (AdminAppsPage, AdminModelsPage)
- Familiarity with the SourceManager and handler architecture
- Basic knowledge of Zod validation schemas

## Phase 1: Backend Foundation (Week 1)

### Step 1.1: Create Source Configuration Schema

Create the Zod schema for validating source configurations:

**File:** `/server/validators/sourceConfigSchema.js`

```javascript
import { z } from 'zod';

const baseSourceSchema = z.object({
  id: z.string().min(1, 'Source ID is required'),
  name: z.record(z.string().min(1, 'Name is required')),
  description: z.record(z.string().optional()),
  type: z.enum(['filesystem', 'url', 'ifinder'], {
    errorMap: () => ({ message: 'Type must be filesystem, url, or ifinder' })
  }),
  enabled: z.boolean().default(true),
  exposeAs: z.enum(['prompt', 'tool']).default('prompt'),
  category: z.string().optional(),
  tags: z.array(z.string()).default([]),
  created: z.string().optional(),
  updated: z.string().optional()
});

const filesystemConfigSchema = z.object({
  basePath: z.string().min(1, 'Base path is required'),
  allowedExtensions: z.array(z.string()).default(['.md', '.txt']),
  maxFileSize: z.number().positive().default(10485760), // 10MB
  encoding: z.string().default('utf-8'),
  recursive: z.boolean().default(true),
  excludePatterns: z.array(z.string()).default([])
});

const urlConfigSchema = z.object({
  url: z.string().url('Valid URL is required'),
  method: z.enum(['GET', 'POST']).default('GET'),
  headers: z.record(z.string()).default({}),
  timeout: z.number().positive().default(10000),
  followRedirects: z.boolean().default(true),
  maxRedirects: z.number().nonnegative().default(5),
  retries: z.number().nonnegative().default(3)
});

const ifinderConfigSchema = z.object({
  baseUrl: z.string().url('iFinder base URL is required'),
  apiKey: z.string().min(1, 'API key is required'),
  searchProfile: z.string().default('default'),
  maxResults: z.number().positive().default(10),
  queryTemplate: z.string().optional(),
  filters: z.record(z.any()).default({})
});

export const sourceConfigSchema = baseSourceSchema.extend({
  config: z.union([
    filesystemConfigSchema,
    urlConfigSchema,
    ifinderConfigSchema
  ])
});

export const sourcesArraySchema = z.array(sourceConfigSchema);

// Validation helper function
export function validateSourceConfig(source) {
  try {
    // Add validation timestamp
    const sourceWithTimestamp = {
      ...source,
      updated: new Date().toISOString()
    };
    
    const validated = sourceConfigSchema.parse(sourceWithTimestamp);
    
    // Additional validation based on type
    if (validated.type === 'filesystem') {
      validateFilesystemPath(validated.config.basePath);
    }
    
    return { success: true, data: validated };
  } catch (error) {
    return { 
      success: false, 
      errors: error.errors || [{ message: error.message }]
    };
  }
}

function validateFilesystemPath(path) {
  // Prevent path traversal attacks
  if (path.includes('..') || path.includes('~') || path.startsWith('/')) {
    throw new Error('Invalid file path: Path traversal not allowed');
  }
  
  // Ensure path is relative and safe
  if (path.startsWith('./')) {
    throw new Error('Paths should not start with ./');
  }
}
```

### Step 1.2: Update ConfigCache for Sources

Modify `/server/configCache.js` to support sources configuration:

**Add to imports:**
```javascript
import { validateSourceConfig } from './validators/sourceConfigSchema.js';
```

**Add to criticalConfigs array (around line 107):**
```javascript
this.criticalConfigs = [
  'config/models.json',
  'config/apps.json', 
  'config/tools.json',
  'config/styles.json',
  'config/prompts.json',
  'config/platform.json',
  'config/ui.json',
  'config/groups.json',
  'config/users.json',
  'config/sources.json' // ADD THIS LINE
];
```

**Add getSources method (after getPrompts method):**
```javascript
getSources(includeDisabled = false) {
  try {
    const sources = this.get('config/sources.json');
    if (!sources || !sources.data) {
      return { data: [], etag: null };
    }

    if (includeDisabled) return sources;

    return {
      data: sources.data.filter(source => source.enabled !== false),
      etag: sources.etag
    };
  } catch (error) {
    console.error('Error loading sources:', error);
    return { data: [], etag: null };
  }
}

async refreshSourcesCache() {
  try {
    await this.refresh('config/sources.json');
    
    // Validate sources after refresh
    const { data: sources } = this.getSources(true);
    for (const source of sources) {
      const validation = validateSourceConfig(source);
      if (!validation.success) {
        console.warn(`Invalid source configuration for ${source.id}:`, validation.errors);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Failed to refresh sources cache:', error);
    return false;
  }
}
```

### Step 1.3: Create Sources Admin Routes

Create `/server/routes/admin/sources.js`:

```javascript
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { validateSourceConfig, sourcesArraySchema } from '../../validators/sourceConfigSchema.js';
import { SourceManager } from '../../sources/SourceManager.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError,
  sendSuccess
} from '../../utils/responseHelpers.js';

let sourceManager = null;

// Initialize source manager
function getSourceManager() {
  if (!sourceManager) {
    sourceManager = new SourceManager();
  }
  return sourceManager;
}

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
      
      sendSuccess(res, 'Source created successfully', newSource);
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
      
      sendSuccess(res, 'Source updated successfully', updatedSource);
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
      
      sendSuccess(res, 'Source deleted successfully');
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
      
      sendSuccess(res, `${updatedCount} sources ${enabled ? 'enabled' : 'disabled'}`);
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
}

// Helper function to save sources configuration
async function saveSourcesConfig(sources) {
  const sourcesPath = join(getRootDir(), 'contents', 'config', 'sources.json');
  
  // Validate entire array
  const validation = sourcesArraySchema.safeParse(sources);
  if (!validation.success) {
    throw new Error(`Sources validation failed: ${validation.error.message}`);
  }
  
  await atomicWriteJSON(sourcesPath, sources);
}

// Helper function to find source dependencies in apps
async function findSourceDependencies(sourceId) {
  try {
    const { data: apps } = configCache.getApps(true);
    const dependencies = [];
    
    for (const app of apps) {
      // Check if app references this source
      if (app.sources && Array.isArray(app.sources)) {
        if (app.sources.some(sourceRef => 
          typeof sourceRef === 'string' ? sourceRef === sourceId : sourceRef.id === sourceId
        )) {
          dependencies.push(app);
        }
      }
      
      // Check legacy source supplements
      if (app.sourceSupplements && Array.isArray(app.sourceSupplements)) {
        const hasLegacyReference = app.sourceSupplements.some(supplement => 
          supplement.sourceId === sourceId
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
```

### Step 1.4: Register Sources Routes

Update `/server/routes/adminRoutes.js` to include sources routes:

```javascript
// Add import
import registerAdminSourcesRoutes from './admin/sources.js';

// Add to route registration function
export default function registerAdminRoutes(app) {
  // ... existing routes ...
  registerAdminSourcesRoutes(app);
}
```

### Step 1.5: Create Default Sources Configuration

Create `/contents/config/sources.json`:

```json
[]
```

Create `/server/defaults/config/sources.json`:

```json
[]
```

## Phase 2: Source Management Service (Week 2)

### Step 2.1: Enhance SourceManager for Admin Operations

Update `/server/sources/SourceManager.js` to add admin functionality:

```javascript
// Add new methods to SourceManager class

/**
 * Test source connection without loading content
 * @param {string} type - Handler type
 * @param {Object} config - Source configuration
 * @returns {Promise<Object>} Test results
 */
async testSource(type, config) {
  const handler = this.handlers.get(type);
  if (!handler) {
    throw new Error(`Unknown source handler: ${type}`);
  }

  // Test connection based on handler type
  switch (type) {
    case 'filesystem':
      return await this.testFilesystemSource(config);
    case 'url':
      return await this.testUrlSource(config);
    case 'ifinder':
      return await this.testIFinderSource(config);
    default:
      throw new Error(`Testing not implemented for handler: ${type}`);
  }
}

/**
 * Test filesystem source
 */
async testFilesystemSource(config) {
  const { basePath, allowedExtensions = ['.md', '.txt'] } = config;
  const fs = await import('fs');
  const path = await import('path');

  try {
    // Check if base path exists and is accessible
    const fullPath = path.resolve(basePath);
    const stats = await fs.promises.stat(fullPath);
    
    if (!stats.isDirectory()) {
      throw new Error('Base path is not a directory');
    }

    // Try to read directory contents
    const files = await fs.promises.readdir(fullPath);
    const relevantFiles = files.filter(file => 
      allowedExtensions.some(ext => file.endsWith(ext))
    );

    return {
      accessible: true,
      totalFiles: files.length,
      relevantFiles: relevantFiles.length,
      sampleFiles: relevantFiles.slice(0, 5)
    };
  } catch (error) {
    throw new Error(`Filesystem test failed: ${error.message}`);
  }
}

/**
 * Test URL source
 */
async testUrlSource(config) {
  const { url, method = 'GET', timeout = 10000, headers = {} } = config;

  try {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Get content type and size
    const contentType = response.headers.get('content-type') || 'unknown';
    const contentLength = response.headers.get('content-length');

    return {
      accessible: true,
      status: response.status,
      statusText: response.statusText,
      contentType,
      contentLength: contentLength ? parseInt(contentLength) : null,
      duration
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw new Error(`URL test failed: ${error.message}`);
  }
}

/**
 * Test iFinder source
 */
async testIFinderSource(config) {
  const { baseUrl, apiKey, searchProfile = 'default' } = config;

  try {
    const testQuery = 'test';
    const startTime = Date.now();
    
    // Use the existing IFinderHandler to test
    const handler = this.handlers.get('ifinder');
    const testConfig = { ...config, query: testQuery, maxResults: 1 };
    
    await handler.loadContent(testConfig);
    const duration = Date.now() - startTime;

    return {
      accessible: true,
      searchProfile,
      duration,
      testQuery
    };
  } catch (error) {
    throw new Error(`iFinder test failed: ${error.message}`);
  }
}

/**
 * Get source statistics
 */
getSourceStats() {
  return {
    registeredHandlers: Array.from(this.handlers.keys()),
    totalTools: this.toolRegistry.size,
    cacheStats: this.getCacheStats()
  };
}

/**
 * Get cache statistics
 */
getCacheStats() {
  // Implementation depends on caching mechanism
  return {
    entries: 0,
    hitRate: 0,
    memoryUsage: 0
  };
}
```

### Step 2.2: Create Source Service Layer

Create `/server/services/SourceConfigService.js`:

```javascript
import configCache from '../configCache.js';
import { validateSourceConfig } from '../validators/sourceConfigSchema.js';
import { SourceManager } from '../sources/SourceManager.js';

/**
 * Service for managing source configurations
 */
export class SourceConfigService {
  constructor() {
    this.sourceManager = new SourceManager();
  }

  /**
   * Get all sources with optional filtering
   */
  async getSources(filters = {}) {
    const { data: sources } = configCache.getSources(!filters.enabledOnly);
    
    let filteredSources = sources;
    
    // Apply filters
    if (filters.type) {
      filteredSources = filteredSources.filter(s => s.type === filters.type);
    }
    
    if (filters.category) {
      filteredSources = filteredSources.filter(s => s.category === filters.category);
    }
    
    if (filters.search) {
      const searchTerm = filters.search.toLowerCase();
      filteredSources = filteredSources.filter(s => 
        Object.values(s.name).some(name => name.toLowerCase().includes(searchTerm)) ||
        Object.values(s.description || {}).some(desc => desc.toLowerCase().includes(searchTerm)) ||
        s.id.toLowerCase().includes(searchTerm)
      );
    }
    
    // Sort by name
    filteredSources.sort((a, b) => {
      const nameA = Object.values(a.name)[0] || a.id;
      const nameB = Object.values(b.name)[0] || b.id;
      return nameA.localeCompare(nameB);
    });
    
    return filteredSources;
  }

  /**
   * Validate source configuration
   */
  validateSource(sourceData) {
    return validateSourceConfig(sourceData);
  }

  /**
   * Test source connection
   */
  async testSource(sourceId, options = {}) {
    const { data: sources } = configCache.getSources(true);
    const source = sources.find(s => s.id === sourceId);
    
    if (!source) {
      throw new Error('Source not found');
    }
    
    if (!source.enabled && !options.force) {
      throw new Error('Source is disabled');
    }
    
    return await this.sourceManager.testSource(source.type, source.config);
  }

  /**
   * Preview source content
   */
  async previewSource(sourceId, options = {}) {
    const { limit = 1000 } = options;
    const { data: sources } = configCache.getSources(true);
    const source = sources.find(s => s.id === sourceId);
    
    if (!source) {
      throw new Error('Source not found');
    }
    
    const content = await this.sourceManager.loadContent(source.type, source.config);
    
    return {
      content: content.substring(0, limit),
      metadata: {
        totalLength: content.length,
        truncated: content.length > limit,
        sourceType: source.type,
        sourceId: sourceId
      }
    };
  }

  /**
   * Get source dependencies (apps using this source)
   */
  async getSourceDependencies(sourceId) {
    const { data: apps } = configCache.getApps(true);
    const dependencies = [];
    
    for (const app of apps) {
      const usesSource = this.checkAppUsesSource(app, sourceId);
      if (usesSource) {
        dependencies.push({
          id: app.id,
          name: app.name,
          type: usesSource.type // 'direct' or 'legacy'
        });
      }
    }
    
    return dependencies;
  }

  /**
   * Check if app uses a specific source
   */
  checkAppUsesSource(app, sourceId) {
    // Check direct source references
    if (app.sources && Array.isArray(app.sources)) {
      const hasDirectReference = app.sources.some(sourceRef => 
        typeof sourceRef === 'string' ? sourceRef === sourceId : sourceRef.id === sourceId
      );
      if (hasDirectReference) {
        return { type: 'direct' };
      }
    }
    
    // Check legacy source supplements
    if (app.sourceSupplements && Array.isArray(app.sourceSupplements)) {
      const hasLegacyReference = app.sourceSupplements.some(supplement => 
        supplement.sourceId === sourceId
      );
      if (hasLegacyReference) {
        return { type: 'legacy' };
      }
    }
    
    return null;
  }

  /**
   * Get system statistics
   */
  async getSystemStats() {
    const { data: sources } = configCache.getSources(true);
    const managerStats = this.sourceManager.getSourceStats();
    
    return {
      sources: {
        total: sources.length,
        enabled: sources.filter(s => s.enabled !== false).length,
        byType: this.groupByType(sources),
        byCategory: this.groupByCategory(sources)
      },
      manager: managerStats
    };
  }

  groupByType(sources) {
    return sources.reduce((acc, source) => {
      acc[source.type] = (acc[source.type] || 0) + 1;
      return acc;
    }, {});
  }

  groupByCategory(sources) {
    return sources.reduce((acc, source) => {
      const category = source.category || 'uncategorized';
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});
  }
}
```

## Phase 3: Frontend Implementation (Week 3)

### Step 3.1: Create AdminSourcesPage Component

Create `/client/src/features/admin/pages/AdminSourcesPage.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';

const AdminSourcesPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSources, setSelectedSources] = useState(new Set());
  const [bulkOperating, setBulkOperating] = useState(false);
  const [testingSource, setTestingSource] = useState(null);

  useEffect(() => {
    loadSources();
  }, []);

  const loadSources = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/sources');
      setSources(response.data || []);
    } catch (err) {
      console.error('Failed to load sources:', err);
      setError(err.message || 'Failed to load sources');
    } finally {
      setLoading(false);
    }
  };

  const filteredSources = sources.filter(source => {
    const matchesSearch = !searchTerm || 
      Object.values(source.name || {}).some(name => 
        name.toLowerCase().includes(searchTerm.toLowerCase())
      ) ||
      source.id.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesType = typeFilter === 'all' || source.type === typeFilter;
    const matchesStatus = statusFilter === 'all' || 
      (statusFilter === 'enabled' && source.enabled !== false) ||
      (statusFilter === 'disabled' && source.enabled === false);
    
    return matchesSearch && matchesType && matchesStatus;
  });

  const handleSourceToggle = async (sourceId) => {
    try {
      const source = sources.find(s => s.id === sourceId);
      const newEnabled = !source.enabled;
      
      await makeAdminApiCall(`/admin/sources/_toggle`, {
        method: 'POST',
        body: JSON.stringify({
          sourceIds: [sourceId],
          enabled: newEnabled
        })
      });
      
      setSources(prev => prev.map(s => 
        s.id === sourceId ? { ...s, enabled: newEnabled } : s
      ));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleBulkToggle = async (enabled) => {
    try {
      setBulkOperating(true);
      const sourceIds = Array.from(selectedSources);
      
      await makeAdminApiCall('/admin/sources/_toggle', {
        method: 'POST', 
        body: JSON.stringify({ sourceIds, enabled })
      });
      
      setSources(prev => prev.map(s => 
        sourceIds.includes(s.id) ? { ...s, enabled } : s
      ));
      
      setSelectedSources(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkOperating(false);
    }
  };

  const handleTestSource = async (sourceId) => {
    try {
      setTestingSource(sourceId);
      const response = await makeAdminApiCall(`/admin/sources/${sourceId}/test`, {
        method: 'POST'
      });
      
      if (response.success) {
        alert(`Source test successful:\n${JSON.stringify(response.result, null, 2)}`);
      } else {
        alert(`Source test failed: ${response.error}`);
      }
    } catch (err) {
      alert(`Source test failed: ${err.message}`);
    } finally {
      setTestingSource(null);
    }
  };

  const handleDeleteSource = async (sourceId) => {
    if (!window.confirm(t('admin.sources.deleteConfirm', 'Are you sure you want to delete this source?'))) {
      return;
    }

    try {
      await makeAdminApiCall(`/admin/sources/${sourceId}`, {
        method: 'DELETE'
      });
      
      setSources(prev => prev.filter(s => s.id !== sourceId));
      setSelectedSources(prev => {
        const newSet = new Set(prev);
        newSet.delete(sourceId);
        return newSet;
      });
    } catch (err) {
      if (err.message.includes('dependencies')) {
        alert(t('admin.sources.deleteDependencies', 'Cannot delete source: it is used by other apps.'));
      } else {
        setError(err.message);
      }
    }
  };

  const handleSourceSelection = (sourceId, checked) => {
    setSelectedSources(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(sourceId);
      } else {
        newSet.delete(sourceId);
      }
      return newSet;
    });
  };

  const getStatusBadge = (source) => {
    const enabled = source.enabled !== false;
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
        enabled 
          ? 'bg-green-100 text-green-800' 
          : 'bg-red-100 text-red-800'
      }`}>
        {enabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
      </span>
    );
  };

  const getTypeBadge = (type) => {
    const colors = {
      filesystem: 'bg-blue-100 text-blue-800',
      url: 'bg-purple-100 text-purple-800', 
      ifinder: 'bg-orange-100 text-orange-800'
    };

    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full ${colors[type] || 'bg-gray-100 text-gray-800'}`}>
        {type}
      </span>
    );
  };

  if (loading) {
    return (
      <AdminAuth>
        <div className="min-h-screen bg-gray-50">
          <AdminNavigation />
          <div className="max-w-7xl mx-auto py-6 px-4">
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <Icon name="arrow-path" className="animate-spin h-8 w-8 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500">{t('common.loading', 'Loading...')}</p>
              </div>
            </div>
          </div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-50">
        <AdminNavigation />
        <div className="max-w-7xl mx-auto py-6 px-4">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-semibold text-gray-900 flex items-center">
                  <Icon name="database" className="h-6 w-6 mr-2" />
                  {t('admin.navigation.sources', 'Sources')}
                </h1>
                <p className="text-gray-600 mt-1">
                  {t('admin.sources.description', 'Manage data sources for your applications')}
                </p>
              </div>
              <button
                onClick={() => navigate('/admin/sources/new')}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium flex items-center"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.sources.createNew', 'Create Source')}
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center">
                <Icon name="x-circle" className="h-5 w-5 text-red-400 mr-2" />
                <p className="text-red-800">{error}</p>
                <button
                  onClick={() => setError(null)}
                  className="ml-auto text-red-600 hover:text-red-800"
                >
                  <Icon name="x-mark" className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.search', 'Search')}
                </label>
                <div className="relative">
                  <Icon name="magnifying-glass" className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder={t('admin.sources.searchPlaceholder', 'Search sources...')}
                    className="pl-10 w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.filterType', 'Type')}
                </label>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="all">{t('admin.sources.allTypes', 'All Types')}</option>
                  <option value="filesystem">{t('admin.sources.filesystem', 'Filesystem')}</option>
                  <option value="url">{t('admin.sources.url', 'URL')}</option>
                  <option value="ifinder">{t('admin.sources.ifinder', 'iFinder')}</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('admin.sources.filterStatus', 'Status')}
                </label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="all">{t('admin.sources.allStatuses', 'All Statuses')}</option>
                  <option value="enabled">{t('common.enabled', 'Enabled')}</option>
                  <option value="disabled">{t('common.disabled', 'Disabled')}</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  onClick={loadSources}
                  className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg font-medium flex items-center"
                >
                  <Icon name="arrow-path" className="h-4 w-4 mr-2" />
                  {t('common.refresh', 'Refresh')}
                </button>
              </div>
            </div>
          </div>

          {/* Bulk Operations */}
          {selectedSources.size > 0 && (
            <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <Icon name="check-circle" className="h-5 w-5 text-indigo-600 mr-2" />
                  <span className="text-indigo-800 font-medium">
                    {t('admin.sources.selectedCount', '{{count}} sources selected', { count: selectedSources.size })}
                  </span>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleBulkToggle(true)}
                    disabled={bulkOperating}
                    className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm font-medium"
                  >
                    {bulkOperating ? t('common.processing', 'Processing...') : t('admin.sources.enableSelected', 'Enable')}
                  </button>
                  <button
                    onClick={() => handleBulkToggle(false)}
                    disabled={bulkOperating}
                    className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm font-medium"
                  >
                    {bulkOperating ? t('common.processing', 'Processing...') : t('admin.sources.disableSelected', 'Disable')}
                  </button>
                  <button
                    onClick={() => setSelectedSources(new Set())}
                    className="bg-gray-500 hover:bg-gray-600 text-white px-3 py-1 rounded text-sm font-medium"
                  >
                    {t('common.clearSelection', 'Clear')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Sources Table */}
          <div className="bg-white rounded-lg shadow-sm overflow-hidden">
            {filteredSources.length === 0 ? (
              <div className="text-center py-12">
                <Icon name="database" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  {sources.length === 0 
                    ? t('admin.sources.noSources', 'No sources configured')
                    : t('admin.sources.noFilteredSources', 'No sources match your filters')
                  }
                </h3>
                <p className="text-gray-500 mb-4">
                  {sources.length === 0
                    ? t('admin.sources.createFirstSource', 'Create your first source to get started')
                    : t('admin.sources.adjustFilters', 'Try adjusting your search and filters')
                  }
                </p>
                {sources.length === 0 && (
                  <button
                    onClick={() => navigate('/admin/sources/new')}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium"
                  >
                    {t('admin.sources.createNew', 'Create Source')}
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left">
                        <input
                          type="checkbox"
                          checked={selectedSources.size === filteredSources.length && filteredSources.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedSources(new Set(filteredSources.map(s => s.id)));
                            } else {
                              setSelectedSources(new Set());
                            }
                          }}
                          className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.name', 'Name')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.type', 'Type')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.status', 'Status')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.updated', 'Updated')}
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {t('admin.sources.actions', 'Actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredSources.map((source) => (
                      <tr key={source.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={selectedSources.has(source.id)}
                            onChange={(e) => handleSourceSelection(source.id, e.target.checked)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                          />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              {Object.values(source.name || {})[0] || source.id}
                            </div>
                            <div className="text-sm text-gray-500 font-mono">
                              {source.id}
                            </div>
                            {source.description && Object.values(source.description)[0] && (
                              <div className="text-xs text-gray-400 mt-1">
                                {Object.values(source.description)[0]}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {getTypeBadge(source.type)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {getStatusBadge(source)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {source.updated ? new Date(source.updated).toLocaleDateString() : '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex items-center justify-end space-x-2">
                            <button
                              onClick={() => handleTestSource(source.id)}
                              disabled={testingSource === source.id}
                              className="text-indigo-600 hover:text-indigo-900 disabled:opacity-50"
                              title={t('admin.sources.testSource', 'Test Source')}
                            >
                              <Icon 
                                name={testingSource === source.id ? "arrow-path" : "beaker"} 
                                className={`h-4 w-4 ${testingSource === source.id ? 'animate-spin' : ''}`} 
                              />
                            </button>
                            <button
                              onClick={() => navigate(`/admin/sources/${source.id}/edit`)}
                              className="text-gray-600 hover:text-gray-900"
                              title={t('admin.sources.editSource', 'Edit Source')}
                            >
                              <Icon name="pencil" className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleSourceToggle(source.id)}
                              className={`${source.enabled !== false ? 'text-red-600 hover:text-red-900' : 'text-green-600 hover:text-green-900'}`}
                              title={source.enabled !== false ? t('common.disable', 'Disable') : t('common.enable', 'Enable')}
                            >
                              <Icon name={source.enabled !== false ? "eye-slash" : "eye"} className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteSource(source.id)}
                              className="text-red-600 hover:text-red-900"
                              title={t('admin.sources.deleteSource', 'Delete Source')}
                            >
                              <Icon name="trash" className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="mt-6 text-center text-sm text-gray-500">
            {t('admin.sources.summary', 'Showing {{filtered}} of {{total}} sources', {
              filtered: filteredSources.length,
              total: sources.length
            })}
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminSourcesPage;
```

### Step 3.2: Create AdminSourceEditPage Component

Due to length constraints, I'll provide the key structure for this component:

Create `/client/src/features/admin/pages/AdminSourceEditPage.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import SourceConfigForm from '../components/SourceConfigForm';
import SourceTestPanel from '../components/SourceTestPanel';
import SourcePreviewPanel from '../components/SourcePreviewPanel';
import { makeAdminApiCall } from '../../../api/adminApi';

const AdminSourceEditPage = () => {
  // Implementation follows similar patterns to AdminAppEditPage
  // Key features:
  // - Dynamic form based on source type
  // - Real-time validation
  // - Test connection functionality
  // - Content preview
  // - Unsaved changes warning
};
```

### Step 3.3: Create Supporting Components

Create the required supporting components:

- `/client/src/features/admin/components/SourceConfigForm.jsx`
- `/client/src/features/admin/components/SourceTestPanel.jsx`
- `/client/src/features/admin/components/SourcePreviewPanel.jsx`
- `/client/src/features/admin/components/SourceTypeSelector.jsx`

### Step 3.4: Update AdminNavigation

Update `/client/src/features/admin/components/AdminNavigation.jsx` to include Sources tab:

```jsx
// Add to navigation items array
{
  id: 'sources',
  name: t('admin.navigation.sources', 'Sources'),
  href: '/admin/sources',
  icon: 'database',
  group: 'content'
}
```

### Step 3.5: Update API Client

Update `/client/src/api/adminApi.js` to include sources endpoints:

```javascript
// Add sources-specific API functions
export const fetchAdminSources = () => makeAdminApiCall('/admin/sources');
export const createSource = (sourceData) => makeAdminApiCall('/admin/sources', {
  method: 'POST',
  body: JSON.stringify(sourceData)
});
export const updateSource = (id, sourceData) => makeAdminApiCall(`/admin/sources/${id}`, {
  method: 'PUT', 
  body: JSON.stringify(sourceData)
});
export const deleteSource = (id) => makeAdminApiCall(`/admin/sources/${id}`, {
  method: 'DELETE'
});
export const testSource = (id) => makeAdminApiCall(`/admin/sources/${id}/test`, {
  method: 'POST'
});
export const previewSource = (id, options = {}) => makeAdminApiCall(`/admin/sources/${id}/preview?${new URLSearchParams(options)}`, {
  method: 'POST'
});
```

## Phase 4: Integration & Migration (Week 4)

### Step 4.1: Update App Configuration Schema

Update `/server/validators/appConfigSchema.js` to support source references:

```javascript
// Add to app schema
sources: z.array(z.union([
  z.string(), // Source ID reference
  z.object({
    id: z.string(),
    config: z.record(z.any()).optional() // Override config
  })
])).optional(),

// Keep backward compatibility
sourceSupplements: z.array(z.record(z.any())).optional()
```

### Step 4.2: Update App Editor

Modify app editor to include source selection interface and integrate with the new source management system.

### Step 4.3: Create Migration Tool

Create `/server/utils/migrateSources.js` for converting existing app sources to global sources:

```javascript
export async function migrateAppSourcesToGlobal() {
  // Implementation for migrating existing app-specific sources
  // to global source configurations
}
```

## Phase 5: Testing & Final Steps (Week 5)

### Step 5.1: Create Test Suite

Create comprehensive tests for the sources administration feature:

```javascript
// /server/tests/sources.test.js
describe('Sources Administration', () => {
  test('creates and manages sources', async () => {
    // Test source CRUD operations
  });

  test('validates source configurations', async () => {
    // Test validation logic
  });

  test('tests source connections', async () => {
    // Test connection testing
  });
});
```

### Step 5.2: Add Backup Integration

Update `/server/routes/admin/backup.js` to include sources in backup:

```javascript
const backupItems = [
  // ... existing items ...
  'config/sources.json'
];
```

### Step 5.3: Final Checks and Validation

Run the complete validation process:

<function_calls>
<invoke name="TodoWrite">
<parameter name="todos">[{"id": "1", "content": "Create comprehensive implementation plan for Sources Administration feature", "status": "completed", "priority": "high"}, {"id": "2", "content": "Backend API implementation (routes, validation, CRUD operations)", "status": "pending", "priority": "high"}, {"id": "3", "content": "Frontend component implementation (pages, forms, preview)", "status": "pending", "priority": "high"}, {"id": "4", "content": "Configuration schema and storage setup", "status": "pending", "priority": "high"}, {"id": "5", "content": "Integration with existing source infrastructure", "status": "pending", "priority": "high"}, {"id": "6", "content": "Testing and validation steps", "status": "pending", "priority": "medium"}, {"id": "7", "content": "Final checks (lint, format, server startup)", "status": "in_progress", "priority": "medium"}, {"id": "8", "content": "Lint and format all code", "status": "pending", "priority": "medium"}, {"id": "9", "content": "Verify server startup with new configuration", "status": "pending", "priority": "medium"}, {"id": "10", "content": "Run comprehensive test suite", "status": "pending", "priority": "medium"}]