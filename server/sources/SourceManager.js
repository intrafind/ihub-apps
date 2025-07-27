import FileSystemHandler from './FileSystemHandler.js';
import URLHandler from './URLHandler.js';
import IFinderHandler from './IFinderHandler.js';

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
    // Register filesystem handler
    this.registerHandler('filesystem', new FileSystemHandler(this.config.filesystem || {}));

    // Register URL handler
    this.registerHandler('url', new URLHandler(this.config.url || {}));

    // Register iFinder handler
    this.registerHandler('ifinder', new IFinderHandler(this.config.ifinder || {}));
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

        results.push({
          id: source.id,
          type: source.type,
          exposeAs: source.exposeAs || 'prompt',
          content: result.content,
          metadata: result.metadata,
          success: true
        });

        // Accumulate content for prompt integration
        if (source.exposeAs !== 'tool') {
          totalContent += `\n\n--- Source: ${source.id} ---\n${result.content}`;
        }
      } catch (error) {
        const errorResult = {
          id: source.id,
          type: source.type,
          exposeAs: source.exposeAs || 'prompt',
          content: '',
          metadata: { error: error.message },
          success: false
        };

        results.push(errorResult);
        errors.push(`Source ${source.id}: ${error.message}`);
      }
    }

    return {
      sources: results,
      content: totalContent.trim(),
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
          tools.push(tool);
        }
      }
    }

    return tools;
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

    // Store tool execution function
    this.toolRegistry.set(toolId, async params => {
      const sourceConfig = {
        ...source.config,
        ...context,
        ...params
      };

      return await handler.getCachedContent(sourceConfig);
    });

    // Generate tool schema based on handler type
    return {
      type: 'function',
      function: {
        name: toolId,
        description: source.description || `Load content from ${source.type} source: ${source.id}`,
        parameters: this.generateToolParameters(source)
      }
    };
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
      return false;
    }

    const { id, type, config, exposeAs } = source;

    // Required fields
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return false;
    }

    if (!type || typeof type !== 'string' || !this.handlers.has(type)) {
      return false;
    }

    if (!config || typeof config !== 'object') {
      return false;
    }

    // Validate exposeAs
    if (exposeAs && !['prompt', 'tool'].includes(exposeAs)) {
      return false;
    }

    // Delegate to handler-specific validation
    const handler = this.handlers.get(type);
    return handler.validateConfig(config);
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
}

export default SourceManager;
