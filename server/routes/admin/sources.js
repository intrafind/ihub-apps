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
import { createSourceManager } from '../../sources/index.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';

/**
 * Initialize source manager singleton
 * @returns {SourceManager} Source manager instance
 */
function getSourceManager() {
  return createSourceManager();
}

/**
 * @swagger
 * components:
 *   schemas:
 *     Source:
 *       type: object
 *       required:
 *         - id
 *         - name
 *         - type
 *         - config
 *       properties:
 *         id:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *           minLength: 1
 *           maxLength: 50
 *           description: Unique identifier for the source
 *         name:
 *           type: object
 *           additionalProperties:
 *             type: string
 *           description: Localized names for the source (language code as key)
 *         description:
 *           type: object
 *           additionalProperties:
 *             type: string
 *           description: Localized descriptions for the source
 *         type:
 *           type: string
 *           enum: [filesystem, url, ifinder, page]
 *           description: Type of source handler
 *         enabled:
 *           type: boolean
 *           default: true
 *           description: Whether the source is enabled
 *         exposeAs:
 *           type: string
 *           enum: [prompt, tool]
 *           default: prompt
 *           description: How the source should be exposed in apps
 *         category:
 *           type: string
 *           description: Source category for organization
 *         tags:
 *           type: array
 *           items:
 *             type: string
 *           description: Tags for source classification
 *         created:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         updated:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 *         config:
 *           oneOf:
 *             - $ref: '#/components/schemas/FilesystemConfig'
 *             - $ref: '#/components/schemas/URLConfig'
 *             - $ref: '#/components/schemas/IFinderConfig'
 *             - $ref: '#/components/schemas/PageConfig'
 *         caching:
 *           $ref: '#/components/schemas/CachingConfig'
 *     FilesystemConfig:
 *       type: object
 *       required:
 *         - path
 *       properties:
 *         path:
 *           type: string
 *           minLength: 1
 *           description: File system path to the content
 *         encoding:
 *           type: string
 *           default: utf-8
 *           description: File encoding
 *     URLConfig:
 *       type: object
 *       required:
 *         - url
 *       properties:
 *         url:
 *           type: string
 *           format: uri
 *           description: URL to fetch content from
 *         method:
 *           type: string
 *           enum: [GET, POST]
 *           default: GET
 *           description: HTTP method
 *         headers:
 *           type: object
 *           additionalProperties:
 *             type: string
 *           description: HTTP headers
 *         timeout:
 *           type: number
 *           minimum: 1000
 *           maximum: 60000
 *           default: 10000
 *           description: Request timeout in milliseconds
 *         followRedirects:
 *           type: boolean
 *           default: true
 *           description: Whether to follow redirects
 *         maxRedirects:
 *           type: number
 *           minimum: 0
 *           maximum: 10
 *           default: 5
 *           description: Maximum number of redirects to follow
 *         retries:
 *           type: number
 *           minimum: 0
 *           maximum: 10
 *           default: 3
 *           description: Number of retry attempts
 *         maxContentLength:
 *           type: number
 *           minimum: 1
 *           default: 1048576
 *           description: Maximum content length in bytes
 *         cleanContent:
 *           type: boolean
 *           default: true
 *           description: Whether to clean HTML content
 *     IFinderConfig:
 *       type: object
 *       required:
 *         - baseUrl
 *         - apiKey
 *       properties:
 *         baseUrl:
 *           type: string
 *           format: uri
 *           description: iFinder base URL
 *         apiKey:
 *           type: string
 *           minLength: 1
 *           description: iFinder API key
 *         searchProfile:
 *           type: string
 *           default: default
 *           description: Search profile to use
 *         maxResults:
 *           type: number
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *           description: Maximum number of search results
 *         queryTemplate:
 *           type: string
 *           default: ""
 *           description: Query template for searches
 *         filters:
 *           type: object
 *           description: Additional search filters
 *         maxLength:
 *           type: number
 *           minimum: 1
 *           default: 10000
 *           description: Maximum content length
 *     PageConfig:
 *       type: object
 *       required:
 *         - pageId
 *       properties:
 *         pageId:
 *           type: string
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *           minLength: 1
 *           description: Page identifier
 *         language:
 *           type: string
 *           default: en
 *           description: Page language code
 *     CachingConfig:
 *       type: object
 *       properties:
 *         ttl:
 *           type: number
 *           minimum: 1
 *           default: 3600
 *           description: Time to live in seconds
 *         strategy:
 *           type: string
 *           enum: [static, refresh]
 *           default: static
 *           description: Caching strategy
 *         enabled:
 *           type: boolean
 *           default: true
 *           description: Whether caching is enabled
 *     SourceStats:
 *       type: object
 *       properties:
 *         total:
 *           type: number
 *           description: Total number of sources
 *         enabled:
 *           type: number
 *           description: Number of enabled sources
 *         disabled:
 *           type: number
 *           description: Number of disabled sources
 *         byType:
 *           type: object
 *           properties:
 *             filesystem:
 *               type: number
 *             url:
 *               type: number
 *             ifinder:
 *               type: number
 *         byExposeAs:
 *           type: object
 *           properties:
 *             prompt:
 *               type: number
 *             tool:
 *               type: number
 *     SourceType:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Type identifier
 *         name:
 *           type: string
 *           description: Display name
 *         description:
 *           type: string
 *           description: Type description
 *         defaultConfig:
 *           type: object
 *           description: Default configuration for this type
 *     TestResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the test was successful
 *         result:
 *           type: object
 *           properties:
 *             connected:
 *               type: boolean
 *               description: Connection status
 *             duration:
 *               type: number
 *               description: Test duration in milliseconds
 *         error:
 *           type: string
 *           description: Error message if test failed
 *         duration:
 *           type: number
 *           description: Test duration in milliseconds
 *     PreviewResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the preview was successful
 *         preview:
 *           type: string
 *           description: Content preview
 *         metadata:
 *           type: object
 *           properties:
 *             totalLength:
 *               type: number
 *               description: Total content length
 *             truncated:
 *               type: boolean
 *               description: Whether content was truncated
 *             encoding:
 *               type: string
 *               description: Content encoding
 *         error:
 *           type: string
 *           description: Error message if preview failed
 *     SourceDependencies:
 *       type: object
 *       properties:
 *         sourceId:
 *           type: string
 *           description: Source ID
 *         dependencies:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               appId:
 *                 type: string
 *                 description: App ID using this source
 *               appName:
 *                 type: string
 *                 description: App name
 *               type:
 *                 type: string
 *                 description: Dependency type
 *     FileSystemFiles:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the operation was successful
 *         path:
 *           type: string
 *           description: Directory path
 *         files:
 *           type: array
 *           items:
 *             type: string
 *           description: List of files
 *         directories:
 *           type: array
 *           items:
 *             type: string
 *           description: List of directories
 *         error:
 *           type: string
 *           description: Error message if operation failed
 *     FileContent:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the operation was successful
 *         content:
 *           type: string
 *           description: File content
 *         metadata:
 *           type: object
 *           description: File metadata
 *         error:
 *           type: string
 *           description: Error message if operation failed
 *     BulkToggleRequest:
 *       type: object
 *       required:
 *         - sourceIds
 *         - enabled
 *       properties:
 *         sourceIds:
 *           type: array
 *           items:
 *             type: string
 *           description: Array of source IDs to toggle
 *         enabled:
 *           type: boolean
 *           description: New enabled state
 *     FileWriteRequest:
 *       type: object
 *       required:
 *         - path
 *         - content
 *       properties:
 *         path:
 *           type: string
 *           description: File path
 *         content:
 *           type: string
 *           description: File content
 *         encoding:
 *           type: string
 *           default: utf8
 *           description: File encoding
 *     OperationResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the operation was successful
 *         message:
 *           type: string
 *           description: Operation result message
 *         result:
 *           type: object
 *           description: Operation result data
 *         error:
 *           type: string
 *           description: Error message if operation failed
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *         message:
 *           type: string
 *           description: Detailed error description
 *         details:
 *           type: object
 *           description: Additional error details
 *
 * @swagger
 * tags:
 *   - name: Admin - Sources
 *     description: Source management endpoints (admin access required)
 */

/**
 * Register all sources administration routes
 * @param {Express} app - Express application instance
 */
export default function registerAdminSourcesRoutes(app, basePath = '') {
  /**
   * @swagger
   * /api/admin/sources:
   *   get:
   *     summary: List all sources
   *     description: Retrieve all configured sources including enabled and disabled ones (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Successfully retrieved all sources
   *         headers:
   *           ETag:
   *             schema:
   *               type: string
   *             description: Entity tag for caching
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Source'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get(buildServerPath('/api/admin/sources', basePath), adminAuth, async (req, res) => {
    try {
      const { data: sources, etag } = configCache.getSources(true);
      res.setHeader('ETag', etag);
      res.json(sources);
    } catch (error) {
      sendFailedOperationError(res, 'fetch sources', error);
    }
  });

  /**
   * @swagger
   * /api/admin/sources/{id}:
   *   get:
   *     summary: Get specific source
   *     description: Retrieve a specific source by its ID (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID
   *     responses:
   *       200:
   *         description: Successfully retrieved source
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Source'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get(buildServerPath('/api/admin/sources/:id', basePath), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;

      // Validate id for security
      if (!validateIdForPath(id, 'source', res)) {
        return;
      }

      // Validate id for security
      if (!validateIdForPath(id, 'source', res)) {
        return;
      }

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

  /**
   * @swagger
   * /api/admin/sources:
   *   post:
   *     summary: Create new source
   *     description: Create a new source with the provided configuration (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/Source'
   *           examples:
   *             filesystem:
   *               summary: Filesystem source example
   *               value:
   *                 id: my-docs
   *                 name:
   *                   en: My Documentation
   *                 description:
   *                   en: Local documentation files
   *                 type: filesystem
   *                 enabled: true
   *                 exposeAs: prompt
   *                 config:
   *                   path: docs/content.md
   *                   encoding: utf-8
   *             url:
   *               summary: URL source example
   *               value:
   *                 id: company-blog
   *                 name:
   *                   en: Company Blog
   *                 description:
   *                   en: Latest company blog posts
   *                 type: url
   *                 enabled: true
   *                 exposeAs: tool
   *                 config:
   *                   url: https://example.com/api/blog
   *                   method: GET
   *                   timeout: 10000
   *     responses:
   *       200:
   *         description: Source created successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   description: Success message
   *                 source:
   *                   $ref: '#/components/schemas/Source'
   *       400:
   *         description: Bad request - Invalid source configuration or duplicate ID
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *                 message:
   *                   type: string
   *                 errors:
   *                   type: array
   *                   items:
   *                     type: object
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.post(buildServerPath('/api/admin/sources', basePath), adminAuth, async (req, res) => {
    try {
      const sourceData = req.body;

      // Validate source ID for security
      if (sourceData.id && !validateIdForPath(sourceData.id, 'source', res)) {
        return;
      }

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

  /**
   * @swagger
   * /api/admin/sources/{id}:
   *   put:
   *     summary: Update source
   *     description: Update an existing source configuration (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/Source'
   *     responses:
   *       200:
   *         description: Source updated successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   description: Success message
   *                 source:
   *                   $ref: '#/components/schemas/Source'
   *       400:
   *         description: Bad request - Invalid source configuration or ID mismatch
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *                 message:
   *                   type: string
   *                 errors:
   *                   type: array
   *                   items:
   *                     type: object
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.put(buildServerPath('/api/admin/sources/:id', basePath), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;

      // Validate id for security
      if (!validateIdForPath(id, 'source', res)) {
        return;
      }

      // Validate id for security
      if (!validateIdForPath(id, 'source', res)) {
        return;
      }

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

  /**
   * @swagger
   * /api/admin/sources/{id}:
   *   delete:
   *     summary: Delete source
   *     description: Delete a source and check for dependencies (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID
   *     responses:
   *       200:
   *         description: Source deleted successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   description: Success message
   *       400:
   *         description: Bad request - Source has dependencies and cannot be deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *                 message:
   *                   type: string
   *                 dependencies:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       appId:
   *                         type: string
   *                       appName:
   *                         type: string
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.delete(buildServerPath('/api/admin/sources/:id', basePath), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;

      // Validate id for security
      if (!validateIdForPath(id, 'source', res)) {
        return;
      }

      // Validate id for security
      if (!validateIdForPath(id, 'source', res)) {
        return;
      }
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

  /**
   * @swagger
   * /api/admin/sources/{id}/test:
   *   post:
   *     summary: Test source connection
   *     description: Test if a source can be connected to and accessed (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID
   *     responses:
   *       200:
   *         description: Source test completed successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TestResult'
   *       400:
   *         description: Source test failed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TestResult'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.post(
    buildServerPath('/api/admin/sources/:id/test', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate id for security
        if (!validateIdForPath(id, 'source', res)) {
          return;
        }
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
    }
  );

  /**
   * @swagger
   * /api/admin/sources/{id}/preview:
   *   post:
   *     summary: Preview source content
   *     description: Get a preview of the content from a source (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID
   *       - in: query
   *         name: limit
   *         required: false
   *         schema:
   *           type: integer
   *           default: 1000
   *           minimum: 1
   *           maximum: 10000
   *         description: Maximum number of characters to return in preview
   *     responses:
   *       200:
   *         description: Source content preview retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PreviewResult'
   *       400:
   *         description: Failed to preview source content
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PreviewResult'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.post(
    buildServerPath('/api/admin/sources/:id/preview', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate id for security
        if (!validateIdForPath(id, 'source', res)) {
          return;
        }
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
    }
  );

  /**
   * @swagger
   * /api/admin/sources/_toggle:
   *   post:
   *     summary: Bulk toggle sources
   *     description: Enable or disable multiple sources at once (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/BulkToggleRequest'
   *           example:
   *             sourceIds: ["source-1", "source-2", "source-3"]
   *             enabled: false
   *     responses:
   *       200:
   *         description: Sources toggled successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   description: Success message with count of updated sources
   *       400:
   *         description: Bad request - Invalid request format
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.post(buildServerPath('/api/admin/sources/_toggle', basePath), adminAuth, async (req, res) => {
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

  /**
   * @swagger
   * /api/admin/sources/_stats:
   *   get:
   *     summary: Get sources statistics
   *     description: Retrieve statistical information about all sources (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Sources statistics retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SourceStats'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get(buildServerPath('/api/admin/sources/_stats', basePath), adminAuth, async (req, res) => {
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

  /**
   * @swagger
   * /api/admin/sources/_types:
   *   get:
   *     summary: Get available source types
   *     description: Retrieve all available source types with their configurations (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Source types retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/SourceType'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get(buildServerPath('/api/admin/sources/_types', basePath), adminAuth, async (req, res) => {
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

  /**
   * @swagger
   * /api/admin/sources/_dependencies/{id}:
   *   get:
   *     summary: Get source dependencies
   *     description: Find apps and other resources that depend on a specific source (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID to check for dependencies
   *     responses:
   *       200:
   *         description: Source dependencies retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SourceDependencies'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get(
    buildServerPath('/api/admin/sources/_dependencies/:id', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate id for security
        if (!validateIdForPath(id, 'source', res)) {
          return;
        }
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
    }
  );

  // Filesystem source file operations

  /**
   * @swagger
   * /api/admin/sources/{id}/files:
   *   get:
   *     summary: List files for filesystem source
   *     description: List files and directories for a filesystem source (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID (must be filesystem type)
   *       - in: query
   *         name: path
   *         required: false
   *         schema:
   *           type: string
   *           default: ""
   *         description: Directory path to list (relative to source root)
   *     responses:
   *       200:
   *         description: Files and directories listed successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/FileSystemFiles'
   *       400:
   *         description: Bad request - Not a filesystem source or operation failed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/FileSystemFiles'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get(
    buildServerPath('/api/admin/sources/:id/files', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate id for security
        if (!validateIdForPath(id, 'source', res)) {
          return;
        }
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
    }
  );

  /**
   * @swagger
   * /api/admin/sources/{id}/files/content:
   *   get:
   *     summary: Get file content for filesystem source
   *     description: Read the content of a specific file from a filesystem source (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID (must be filesystem type)
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *         description: File path to read (relative to source root)
   *     responses:
   *       200:
   *         description: File content retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/FileContent'
   *       400:
   *         description: Bad request - Not a filesystem source, missing path, or operation failed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/FileContent'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get(
    buildServerPath('/api/admin/sources/:id/files/content', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate id for security
        if (!validateIdForPath(id, 'source', res)) {
          return;
        }
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
    }
  );

  /**
   * @swagger
   * /api/admin/sources/{id}/files:
   *   post:
   *     summary: Write file for filesystem source
   *     description: Create or overwrite a file in a filesystem source (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID (must be filesystem type)
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/FileWriteRequest'
   *           example:
   *             path: "docs/example.md"
   *             content: "# Example Document\n\nThis is example content."
   *             encoding: "utf8"
   *     responses:
   *       200:
   *         description: File written successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/OperationResult'
   *       400:
   *         description: Bad request - Not a filesystem source, missing parameters, or operation failed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/OperationResult'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.post(
    buildServerPath('/api/admin/sources/:id/files', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate id for security
        if (!validateIdForPath(id, 'source', res)) {
          return;
        }
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
    }
  );

  /**
   * @swagger
   * /api/admin/sources/{id}/files:
   *   delete:
   *     summary: Delete file for filesystem source
   *     description: Delete a file from a filesystem source (admin access required)
   *     tags: [Admin - Sources]
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9_-]+$'
   *         description: Source ID (must be filesystem type)
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *         description: File path to delete (relative to source root)
   *     responses:
   *       200:
   *         description: File deleted successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/OperationResult'
   *       400:
   *         description: Bad request - Not a filesystem source, missing path, or operation failed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/OperationResult'
   *       401:
   *         description: Unauthorized - Invalid or missing authentication
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Forbidden - Insufficient admin permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Source not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.delete(
    buildServerPath('/api/admin/sources/:id/files', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate id for security
        if (!validateIdForPath(id, 'source', res)) {
          return;
        }
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
    }
  );
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
