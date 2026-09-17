import SourceHandler from './SourceHandler.js';
import iFinder from '../tools/iFinder.js';

/**
 * iFinder Source Handler
 *
 * Loads content from iFinder document management system using the existing
 * iFinder tool integration. Supports searching and retrieving documents
 * with user authentication and caching.
 */
class IFinderHandler extends SourceHandler {
  constructor(config = {}) {
    super(config);
    // Longer TTL for document content since it changes less frequently
    this.cacheConfig = { ttl: 7200, strategy: 'static', ...config.caching };
  }

  /**
   * Load content from iFinder
   *
   * Connection settings come from the central iFinder integration (platform
   * config); the source config only selects documents. Two modes:
   * - documentId: load exactly that document
   * - query: search and load the top `maxResults` matching documents
   *
   * @param {Object} sourceConfig - { documentId?: string, query?: string, searchProfile?: string, maxResults?: number, maxLength?: number, user: Object, chatId: string }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadContent(sourceConfig) {
    const {
      documentId,
      query,
      searchProfile,
      user,
      chatId,
      maxLength = 10000, // matches the source schema default
      maxResults = 10
    } = sourceConfig;

    if (!user) {
      throw new Error('IFinderHandler requires authenticated user in sourceConfig');
    }

    if (!chatId) {
      throw new Error('IFinderHandler requires chatId in sourceConfig');
    }

    if (!documentId && !query) {
      throw new Error('IFinderHandler requires either documentId or query in sourceConfig');
    }

    try {
      if (documentId) {
        return await this.loadSingleDocument({
          documentId,
          searchProfile,
          user,
          chatId,
          maxLength
        });
      }

      return await this.loadDocumentsByQuery({
        query,
        searchProfile,
        user,
        chatId,
        maxLength,
        maxResults
      });
    } catch (error) {
      throw new Error(`Error loading from iFinder: ${error.message}`);
    }
  }

  /**
   * Load one specific document with its metadata
   * @param {Object} params - { documentId, searchProfile, user, chatId, maxLength }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadSingleDocument({ documentId, searchProfile, user, chatId, maxLength }) {
    const contentResult = await iFinder.getContent({
      documentId,
      chatId,
      user,
      searchProfile,
      maxLength
    });

    const metadataResult = await iFinder.getMetadata({
      documentId,
      chatId,
      user,
      searchProfile
    });

    return {
      content: contentResult.content,
      metadata: {
        type: 'ifinder',
        documentId,
        link: metadataResult.url || `ifinder://document/${documentId}`, // Use document URL if available
        title: metadataResult.title,
        author: metadataResult.author,
        documentType: metadataResult.documentType,
        mimeType: metadataResult.mimeType,
        size: metadataResult.size,
        sizeFormatted: metadataResult.sizeFormatted,
        createdDate: metadataResult.createdDate,
        lastModified: metadataResult.lastModified,
        contentLength: contentResult.contentLength,
        contentLengthFormatted: contentResult.contentLengthFormatted,
        searchProfile: contentResult.searchProfile,
        truncated: contentResult.truncated,
        loadedAt: new Date().toISOString()
      }
    };
  }

  /**
   * Search for documents and load the content of the top matches
   * @param {Object} params - { query, searchProfile, user, chatId, maxLength, maxResults }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadDocumentsByQuery({ query, searchProfile, user, chatId, maxLength, maxResults }) {
    const searchResults = await iFinder.search({
      query,
      chatId,
      user,
      maxResults,
      searchProfile
    });

    const hits = searchResults.results || [];
    if (hits.length === 0) {
      throw new Error(`No documents found for query: ${query}`);
    }

    const loaded = [];
    const failed = [];
    const concurrency = 3;

    // Load document contents in small batches to avoid overwhelming iFinder
    for (let i = 0; i < hits.length; i += concurrency) {
      const batch = hits.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async hit => {
          try {
            const contentResult = await iFinder.getContent({
              documentId: hit.id,
              chatId,
              user,
              searchProfile,
              maxLength
            });
            return { hit, contentResult };
          } catch (error) {
            failed.push({ documentId: hit.id, error: error.message });
            return null;
          }
        })
      );
      loaded.push(...batchResults.filter(Boolean));
    }

    if (loaded.length === 0) {
      throw new Error(
        `Failed to load documents for query "${query}": ${failed.map(f => f.error).join('; ')}`
      );
    }

    const content = loaded
      .map(({ hit, contentResult }) => {
        const title = hit.title || contentResult.metadata?.title || hit.id;
        const link = hit.url || hit.deepLink || '';
        const linkAttr = link ? ` link="${this.escapeAttribute(link)}"` : '';
        return `<document id="${this.escapeAttribute(hit.id)}" title="${this.escapeAttribute(title)}"${linkAttr}>\n${contentResult.content}\n</document>`;
      })
      .join('\n\n');

    return {
      content,
      metadata: {
        type: 'ifinder',
        searchQuery: query,
        searchProfile: searchResults.searchProfile,
        totalFound: searchResults.totalFound,
        loadedDocuments: loaded.length,
        failedDocuments: failed,
        documents: loaded.map(({ hit, contentResult }) => ({
          documentId: hit.id,
          title: hit.title,
          author: hit.author,
          mimeType: hit.mimeType,
          size: hit.size,
          lastModified: hit.lastModified,
          link: hit.url || hit.deepLink || `ifinder://document/${hit.id}`,
          contentLength: contentResult.contentLength,
          truncated: contentResult.truncated || false
        })),
        loadedAt: new Date().toISOString()
      }
    };
  }

  /**
   * Escape a value for use inside a double-quoted XML-style attribute
   * @param {*} value - Value to escape
   * @returns {string} - Escaped string
   */
  escapeAttribute(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Enhanced cache key that includes user context
   * @param {Object} sourceConfig - Configuration specific to this source
   * @returns {string} - Cache key
   */
  getCacheKey(sourceConfig) {
    const { documentId, query, searchProfile, maxResults, maxLength, user } = sourceConfig;

    // Create user-specific cache key to avoid permission issues
    const userKey = user ? user.email || user.id : 'anonymous';

    return JSON.stringify({
      documentId,
      query,
      searchProfile,
      maxResults,
      maxLength,
      user: userKey
    });
  }

  /**
   * Get handler type identifier
   */
  getType() {
    return 'ifinder';
  }

  /**
   * Validate iFinder source configuration
   *
   * Only static configuration is validated here — the runtime context
   * (user, chatId) is injected later by the SourceManager and enforced in
   * loadContent, so requiring it here would reject every stored source.
   *
   * @param {Object} sourceConfig - Configuration to validate
   * @returns {boolean} - True if valid
   */
  validateConfig(sourceConfig) {
    if (!sourceConfig || typeof sourceConfig !== 'object') {
      return false;
    }

    const { documentId, query } = sourceConfig;

    const hasDocumentId = typeof documentId === 'string' && documentId.trim() !== '';
    const hasQuery = typeof query === 'string' && query.trim() !== '';

    // Must have either documentId or query
    return hasDocumentId || hasQuery;
  }

  /**
   * Search for documents in iFinder
   * @param {Object} searchConfig - { query: string, user: Object, chatId: string, maxResults?: number, searchProfile?: string }
   * @returns {Promise<Array>} - Array of document metadata
   */
  async searchDocuments(searchConfig) {
    const { query, user, chatId, maxResults = 10, searchProfile, returnFields } = searchConfig;

    if (!this.validateSearchConfig(searchConfig)) {
      throw new Error('Invalid search configuration for iFinder');
    }

    try {
      const searchResults = await iFinder.search({
        query,
        chatId,
        user,
        maxResults,
        searchProfile,
        returnFields
      });

      return searchResults.results.map(result => ({
        documentId: result.id,
        title: result.title,
        author: result.author,
        documentType: result.documentType,
        mimeType: result.mimeType,
        createdDate: result.createdDate,
        lastModified: result.lastModified,
        score: result.score,
        teasers: result.teasers,
        filename: result.filename,
        url: result.url,
        size: result.size
      }));
    } catch (error) {
      throw new Error(`Error searching iFinder: ${error.message}`);
    }
  }

  /**
   * Validate search configuration
   * @param {Object} searchConfig - Search configuration to validate
   * @returns {boolean} - True if valid
   */
  validateSearchConfig(searchConfig) {
    if (!searchConfig || typeof searchConfig !== 'object') {
      return false;
    }

    const { query, user, chatId } = searchConfig;

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return false;
    }

    if (!user || typeof user !== 'object' || (user.id && user.id === 'anonymous')) {
      return false;
    }

    if (!chatId || typeof chatId !== 'string') {
      return false;
    }

    return true;
  }

  /**
   * Batch load multiple documents
   * @param {Array} documentIds - Array of document IDs
   * @param {Object} options - Batch options with user and chatId
   * @returns {Promise<Array>} - Array of document content results
   */
  async batchLoadDocuments(documentIds, options = {}) {
    const { user, chatId, searchProfile, concurrency = 3, failureMode = 'continue' } = options;
    const results = [];

    if (!user || !chatId) {
      throw new Error('batchLoadDocuments requires user and chatId in options');
    }

    // Process documents in batches to avoid overwhelming iFinder
    for (let i = 0; i < documentIds.length; i += concurrency) {
      const batch = documentIds.slice(i, i + concurrency);
      const promises = batch.map(async documentId => {
        try {
          return await this.getCachedContent({
            documentId,
            user,
            chatId,
            searchProfile
          });
        } catch (error) {
          if (failureMode === 'stop') {
            throw error;
          }
          return {
            content: '',
            metadata: {
              type: 'ifinder',
              documentId,
              link: `ifinder://document/${documentId}`, // Provide link even on error
              error: error.message,
              loadedAt: new Date().toISOString()
            }
          };
        }
      });

      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
    }

    return results;
  }
}

export default IFinderHandler;
