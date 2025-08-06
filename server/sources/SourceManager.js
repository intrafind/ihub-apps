import FileSystemHandler from './FileSystemHandler.js';
import URLHandler from './URLHandler.js';
import IFinderHandler from './IFinderHandler.js';
import PageHandler from './PageHandler.js';

// Global registry for source tool functions (persists across SourceManager instances)
const globalSourceToolRegistry = new Map();

/**
 * Source Manager
 *
 * Centralized manager for all source handlers. Provides unified interface
 * for loading content from various sources with caching and tool generation.
 */
class SourceManager {
  constructor(config = {}) {
    this.config = config;
    this.handlers = new Map();
    this.toolRegistry = new Map();

    // Initialize default handlers
    this.initializeHandlers();
  }

  /**
   * Initialize default source handlers
   */
  initializeHandlers() {
    try {
      // Register filesystem handler
      console.log('Initializing FileSystem handler...');
      this.registerHandler('filesystem', new FileSystemHandler(this.config.filesystem || {}));
      console.log('✓ FileSystem handler registered successfully');

      // Register URL handler
      console.log('Initializing URL handler...');
      this.registerHandler('url', new URLHandler(this.config.url || {}));
      console.log('✓ URL handler registered successfully');

      // Register iFinder handler
      console.log('Initializing iFinder handler...');
      this.registerHandler('ifinder', new IFinderHandler(this.config.ifinder || {}));
      console.log('✓ iFinder handler registered successfully');

      // Register Page handler
      console.log('Initializing Page handler...');
      this.registerHandler('page', new PageHandler(this.config.page || {}));
      console.log('✓ Page handler registered successfully');

      console.log(
        `✓ All source handlers initialized: ${Array.from(this.handlers.keys()).join(', ')}`
      );
    } catch (error) {
      console.error('Error initializing source handlers:', error.message);
      console.error('Stack trace:', error.stack);
      throw new Error(`Failed to initialize source handlers: ${error.message}`);
    }
  }

  /**
   * Register a new source handler
   * @param {string} type - Handler type identifier
   * @param {SourceHandler} handler - Handler instance
   */
  registerHandler(type, handler) {
    if (!type || typeof type !== 'string') {
      throw new Error('Handler type must be a non-empty string');
    }

    if (!handler || typeof handler.loadContent !== 'function') {
      throw new Error('Handler must implement loadContent method');
    }

    this.handlers.set(type, handler);
  }

  /**
   * Get handler by type
   * @param {string} type - Handler type
   * @returns {SourceHandler} - Handler instance
   */
  getHandler(type) {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`No handler registered for type: ${type}`);
    }
    return handler;
  }

  /**
   * Load content from multiple sources
   * @param {Array} sources - Array of source configurations
   * @param {Object} context - Context (user, chatId, etc.)
   * @returns {Promise<Object>} - { sources: Array, content: string, metadata: Object }
   */
  async loadSources(sources, context = {}) {
    if (!Array.isArray(sources) || sources.length === 0) {
      return {
        sources: [],
        content: '',
        metadata: { totalSources: 0, loadedSources: 0, errors: [] }
      };
    }

    const results = [];
    const errors = [];
    let totalContent = '';

    for (const source of sources) {
      try {
        // Skip loading content for tool sources - they should only be loaded when the tool is called
        if (source.exposeAs === 'tool') {
          results.push({
            id: source.id,
            name: source.name,
            type: source.type,
            link: source.config?.url || source.config?.path || '',
            exposeAs: 'tool',
            description: source.description || `Content from ${source.id}`,
            content: '',
            metadata: { skipped: true, reason: 'Tool source - loaded on demand' },
            success: true
          });
          continue;
        }

        // Validate source configuration
        if (!this.validateSourceConfig(source)) {
          throw new Error(`Invalid source configuration: ${JSON.stringify(source)}`);
        }

        const handler = this.getHandler(source.type);

        // Merge context into source config
        const sourceConfig = {
          ...source.config,
          ...context
        };

        // Load content
        const result = await handler.getCachedContent(sourceConfig);

        // Extract original link from source config for different source types
        let originalLink = result.metadata?.link || source.link || '';
        if (!originalLink && source.config) {
          if (source.type === 'url' && source.config.url) {
            originalLink = source.config.url;
          } else if (source.type === 'filesystem' && source.config.path) {
            originalLink = source.config.path;
          }
        }

        results.push({
          id: source.id,
          name: source.name,
          type: source.type,
          link: originalLink,
          exposeAs: source.exposeAs || 'prompt',
          description: source.description || `Content from ${source.id}`,
          content: result.content,
          metadata: { ...result.metadata, originalUrl: originalLink },
          success: true
        });

        // Accumulate content for prompt integration
        if (source.exposeAs !== 'tool') {
          const sourceLink = result.metadata?.link || source.link || '';
          totalContent += `\n\n<source id="${source.id}" type="${source.type}" link="${sourceLink}">\n${result.content}\n</source>`;
        }
      } catch (error) {
        const errorResult = {
          id: source.id,
          name: source.name,
          type: source.type,
          exposeAs: source.exposeAs || 'prompt',
          description: source.description || `Content from ${source.id}`,
          link: source.config?.url || source.config?.path || '',
          content: '',
          metadata: {
            error: error.message,
            errorStack: error.stack,
            errorCode: error.code || 'UNKNOWN_ERROR'
          },
          success: false
        };

        results.push(errorResult);
        errors.push(`Source ${source.id}: ${error.message}`);
      }
    }

    // Generate enhanced sources template with both prompt and tool sources
    const enhancedContent = this.generateEnhancedSourcesTemplate(
      results,
      totalContent.trim(),
      context
    );

    return {
      sources: results,
      content: enhancedContent,
      metadata: {
        totalSources: sources.length,
        loadedSources: results.filter(r => r.success).length,
        failedSources: results.filter(r => !r.success).length,
        errors,
        loadedAt: new Date().toISOString()
      }
    };
  }

  /**
   * Generate tools for sources marked as 'tool'
   * @param {Array} sources - Array of source configurations
   * @param {Object} context - Context (user, chatId, etc.)
   * @returns {Array} - Array of tool definitions
   */
  generateTools(sources, context = {}) {
    const tools = [];

    for (const source of sources) {
      if (source.exposeAs === 'tool') {
        const tool = this.createSourceTool(source, context);
        if (tool) {
          // Validate tool structure before adding (generic format)
          if (tool.name && tool.description && tool.parameters) {
            tools.push(tool);
          } else {
            console.error(
              `Invalid tool generated for source ${source.id}:`,
              JSON.stringify(tool, null, 2)
            );
          }
        }
      }
    }

    return tools;
  }

  /**
   * Generate enhanced sources template that includes both prompt sources (with content)
   * and tool sources (with function references)
   * @param {Array} results - Source loading results
   * @param {string} promptContent - Existing prompt-based source content
   * @param {Object} context - Context with language information
   * @returns {string} Enhanced sources template
   */
  generateEnhancedSourcesTemplate(results, promptContent, context = {}) {
    const sourceEntries = [];

    for (const result of results) {
      if (result.success) {
        if (result.exposeAs === 'tool') {
          // Tool-based source - include as function reference with human-friendly name
          const link = result.link || '';

          // Localize description
          let description = result.description || `Content from ${result.id}`;
          if (typeof description === 'object') {
            description =
              description.en || Object.values(description)[0] || `Content from ${result.id}`;
          }

          // Get human-friendly display name
          const language = context.language || 'en';
          let displayName = result.id; // fallback to ID if no name
          if (result.name) {
            if (typeof result.name === 'string') {
              displayName = result.name;
            } else if (typeof result.name === 'object' && result.name !== null) {
              displayName =
                result.name[language] ||
                result.name.en ||
                Object.values(result.name)[0] ||
                result.id;
            }
          }

          sourceEntries.push(
            `  <source id="${result.id}" type="function" name="source_${result.id}" displayName="${displayName}" link="${link}" description="${description}"/>`
          );
        } else {
          // Prompt-based source - include directly in content (already handled in totalContent)
          // Just add metadata entry to the list
          const link = result.link || '';
          let description = result.description || `Content from ${result.id}`;
          if (typeof description === 'object') {
            description =
              description.en || Object.values(description)[0] || `Content from ${result.id}`;
          }

          sourceEntries.push(
            `  <source id="${result.id}" type="${result.type}" link="${link}" description="${description}"/>`
          );
        }
      }
    }

    if (sourceEntries.length > 0) {
      const sourcesHeader = `<sources>\n${sourceEntries.join('\n')}\n</sources>\n\n`;
      return sourcesHeader + promptContent;
    }

    return promptContent;
  }

  /**
   * Create a tool definition for a source
   * @param {Object} source - Source configuration
   * @param {Object} context - Context
   * @returns {Object} - Tool definition
   */
  createSourceTool(source, context) {
    const handler = this.handlers.get(source.type);
    if (!handler) {
      return null;
    }

    const toolId = `source_${source.id}`;

    // Store tool execution function in global registry
    const toolFunction = async params => {
      const sourceConfig = {
        ...source.config,
        ...context,
        ...params
      };

      return await handler.getCachedContent(sourceConfig);
    };

    this.toolRegistry.set(toolId, toolFunction);
    globalSourceToolRegistry.set(toolId, toolFunction);

    // Localize description
    const language = context.language || 'en';
    let description = source.description || `Load content from ${source.type} source: ${source.id}`;

    // Handle multilingual descriptions
    if (typeof description === 'object' && description[language]) {
      description = description[language];
    } else if (typeof description === 'object' && description.en) {
      description = description.en; // fallback to English
    }

    // Get human-friendly name
    let displayName = source.id; // fallback to ID if no name
    if (source.name) {
      if (typeof source.name === 'string') {
        displayName = source.name;
      } else if (typeof source.name === 'object') {
        displayName =
          source.name[language] || source.name.en || Object.values(source.name)[0] || source.id;
      }
    }

    // Generate tool schema in generic format (will be converted by provider adapters)
    const tool = {
      name: toolId,
      displayName: displayName,
      description: description,
      parameters: this.generateToolParameters(source)
    };

    return tool;
  }

  /**
   * Generate tool parameters schema based on source type
   * @param {Object} source - Source configuration
   * @returns {Object} - Parameters schema
   */
  generateToolParameters(source) {
    const baseSchema = {
      type: 'object',
      properties: {},
      required: []
    };

    switch (source.type) {
      case 'filesystem':
        baseSchema.properties.path = {
          type: 'string',
          description: 'File path to load (optional if configured in source)'
        };
        break;

      case 'url':
        baseSchema.properties.url = {
          type: 'string',
          description: 'URL to fetch (optional if configured in source)'
        };
        baseSchema.properties.maxContentLength = {
          type: 'number',
          description: 'Maximum content length to fetch'
        };
        break;

      case 'ifinder':
        baseSchema.properties.query = {
          type: 'string',
          description: 'Search query for documents'
        };
        baseSchema.properties.documentId = {
          type: 'string',
          description: 'Specific document ID to retrieve'
        };
        baseSchema.properties.maxResults = {
          type: 'number',
          description: 'Maximum number of search results'
        };
        break;

      case 'page':
        baseSchema.properties.pageId = {
          type: 'string',
          description: 'Page identifier to load (required)'
        };
        baseSchema.properties.language = {
          type: 'string',
          description: 'Language code for the page (e.g., "en", "de")'
        };
        baseSchema.required = ['pageId'];
        break;
    }

    return baseSchema;
  }

  /**
   * Execute a source tool
   * @param {string} toolId - Tool identifier
   * @param {Object} params - Tool parameters
   * @returns {Promise<Object>} - Tool execution result
   */
  async executeTool(toolId, params) {
    const toolFunction = this.toolRegistry.get(toolId);
    if (!toolFunction) {
      throw new Error(`Tool not found: ${toolId}`);
    }

    return await toolFunction(params);
  }

  /**
   * Validate source configuration
   * @param {Object} source - Source configuration
   * @returns {boolean} - True if valid
   */
  validateSourceConfig(source) {
    if (!source || typeof source !== 'object') {
      console.error('Source configuration must be an object');
      return false;
    }

    const { id, type, config, exposeAs } = source;

    // Required fields
    if (!id || typeof id !== 'string' || id.trim() === '') {
      console.error('Source configuration must have a valid id string');
      return false;
    }

    if (!type || typeof type !== 'string') {
      console.error(`Source ${id}: type must be a non-empty string`);
      return false;
    }

    if (!this.handlers.has(type)) {
      console.error(
        `Source ${id}: unknown handler type '${type}'. Available types: ${Array.from(this.handlers.keys()).join(', ')}`
      );
      return false;
    }

    if (!config || typeof config !== 'object') {
      console.error(`Source ${id}: config must be an object`);
      return false;
    }

    // Validate exposeAs
    if (exposeAs && !['prompt', 'tool'].includes(exposeAs)) {
      console.error(`Source ${id}: exposeAs must be either 'prompt' or 'tool', got '${exposeAs}'`);
      return false;
    }

    // Delegate to handler-specific validation
    try {
      const handler = this.handlers.get(type);
      const isValid = handler.validateConfig(config);
      if (!isValid) {
        console.error(`Source ${id}: handler-specific configuration validation failed`);
      }
      return isValid;
    } catch (error) {
      console.error(`Source ${id}: error during handler validation:`, error.message);
      return false;
    }
  }

  /**
   * Get all registered handler types
   * @returns {Array} - Array of handler types
   */
  getHandlerTypes() {
    return Array.from(this.handlers.keys());
  }

  /**
   * Clear all handler caches
   */
  clearAllCaches() {
    for (const handler of this.handlers.values()) {
      handler.clearCache();
    }
  }

  /**
   * Get cache statistics for all handlers
   * @returns {Object} - Cache statistics by handler type
   */
  getCacheStats() {
    const stats = {};

    for (const [type, handler] of this.handlers.entries()) {
      stats[type] = handler.getCacheStats();
    }

    return stats;
  }

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
      case 'page':
        return await this.testPageSource(config);
      default:
        throw new Error(`Testing not implemented for handler: ${type}`);
    }
  }

  /**
   * Test filesystem source
   */
  async testFilesystemSource(config) {
    const { path: filePath, encoding = 'utf-8' } = config;
    const fs = await import('fs');
    const path = await import('path');
    const { getRootDir } = await import('../pathUtils.js');

    try {
      if (!filePath) {
        throw new Error('File path is required');
      }

      // Resolve path relative to contents directory
      const contentsDir = path.join(getRootDir(), 'contents');
      const fullPath = path.resolve(contentsDir, filePath);

      // Security check: ensure resolved path stays within contents directory
      if (!fullPath.startsWith(contentsDir)) {
        throw new Error('Invalid file path: Path must be within contents directory');
      }

      const stats = await fs.promises.stat(fullPath);

      if (!stats.isFile()) {
        throw new Error('Path is not a file');
      }

      // Try to read the file to verify accessibility
      const content = await fs.promises.readFile(fullPath, encoding);
      const fileSize = stats.size;

      return {
        accessible: true,
        relativePath: filePath,
        fileSize,
        contentLength: Buffer.byteLength(content, encoding),
        encoding,
        lastModified: stats.mtime.toISOString()
      };
    } catch (error) {
      // Never expose full filesystem paths in error messages
      const sanitizedMessage = error.message.replace(/\/[^/\s]+/g, '[path]');
      throw new Error(`Filesystem test failed: ${sanitizedMessage}`);
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

      // Get content type and count actual content size
      const contentType = response.headers.get('content-type') || 'unknown';
      const headerContentLength = response.headers.get('content-length');

      // Read the content to count its actual size
      const content = await response.text();
      const actualContentLength = Buffer.byteLength(content, 'utf8');

      return {
        accessible: true,
        status: response.status,
        statusText: response.statusText,
        contentType,
        contentLength: actualContentLength,
        headerContentLength: headerContentLength ? parseInt(headerContentLength) : null,
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
    const { searchProfile = 'default' } = config;

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
   * Test page source
   */
  async testPageSource(config) {
    const { pageId, language = 'en' } = config;

    if (!pageId) {
      throw new Error('Page testing requires a pageId');
    }

    try {
      const handler = this.handlers.get('page');
      const result = await handler.pageExists(pageId);

      if (!result.exists) {
        throw new Error(`Page '${pageId}' not found in any language`);
      }

      return {
        accessible: true,
        pageId,
        requestedLanguage: language,
        availableLanguages: result.languages,
        defaultLanguage: handler.defaultLanguage,
        url: handler.generatePageUrl(pageId, language)
      };
    } catch (error) {
      throw new Error(`Page test failed: ${error.message}`);
    }
  }

  /**
   * Load content from a source (for preview functionality)
   * @param {string} type - Source type
   * @param {Object} config - Source configuration
   * @returns {Promise<string>} Content
   */
  async loadContent(type, config) {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`Unknown source handler: ${type}`);
    }

    const result = await handler.loadContent(config);
    return result.content || result;
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
   * Process app sources configuration
   * @param {Object} app - App configuration
   * @param {Object} context - Request context
   * @returns {Promise<Object>} - Processed sources result
   */
  async processAppSources(app, context) {
    if (!app.sources || !Array.isArray(app.sources)) {
      return {
        sources: [],
        content: '',
        tools: [],
        metadata: { totalSources: 0, loadedSources: 0, errors: [] }
      };
    }

    // Load sources
    const sourcesResult = await this.loadSources(app.sources, context);

    // Generate tools
    const tools = this.generateTools(app.sources, context);

    return {
      sources: sourcesResult.sources,
      content: sourcesResult.content,
      tools,
      metadata: sourcesResult.metadata
    };
  }

  /**
   * Get a tool function from the registry
   * @param {string} toolId - Tool ID to retrieve
   * @returns {Function|null} - Tool execution function or null if not found
   */
  getToolFunction(toolId) {
    return this.toolRegistry.get(toolId) || globalSourceToolRegistry.get(toolId) || null;
  }
}

export default SourceManager;
