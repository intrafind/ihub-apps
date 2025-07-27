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
   * @param {Object} sourceConfig - { documentId?: string, query?: string, searchProfile?: string, user: Object, chatId: string }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadContent(sourceConfig) {
    const { documentId, query, searchProfile, user, chatId, maxLength = 50000 } = sourceConfig;

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
      let targetDocumentId = documentId;
      let searchResults = null;

      // If only query provided, search first to get document ID
      if (!documentId && query) {
        searchResults = await iFinder.search({
          query,
          chatId,
          user,
          maxResults: 1,
          searchProfile
        });

        if (!searchResults.results || searchResults.results.length === 0) {
          throw new Error(`No documents found for query: ${query}`);
        }

        targetDocumentId = searchResults.results[0].id;
      }

      // Get document content
      const contentResult = await iFinder.getContent({
        documentId: targetDocumentId,
        chatId,
        user,
        searchProfile,
        maxLength
      });

      // Get additional metadata if needed
      const metadataResult = await iFinder.getMetadata({
        documentId: targetDocumentId,
        chatId,
        user,
        searchProfile
      });

      return {
        content: contentResult.content,
        metadata: {
          type: 'ifinder',
          documentId: targetDocumentId,
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
          searchQuery: query,
          searchResults: searchResults,
          loadedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      throw new Error(`Error loading from iFinder: ${error.message}`);
    }
  }

  /**
   * Enhanced cache key that includes user context
   * @param {Object} sourceConfig - Configuration specific to this source
   * @returns {string} - Cache key
   */
  getCacheKey(sourceConfig) {
    const { documentId, query, searchProfile, user } = sourceConfig;

    // Create user-specific cache key to avoid permission issues
    const userKey = user ? user.email || user.id : 'anonymous';

    return JSON.stringify({
      documentId,
      query,
      searchProfile,
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
   * @param {Object} sourceConfig - Configuration to validate
   * @returns {boolean} - True if valid
   */
  validateConfig(sourceConfig) {
    if (!sourceConfig || typeof sourceConfig !== 'object') {
      return false;
    }

    const { documentId, query, user, chatId } = sourceConfig;

    // Must have either documentId or query
    if (!documentId && !query) {
      return false;
    }

    // Must have user and chatId
    if (!user || !chatId) {
      return false;
    }

    // Validate user object
    if (typeof user !== 'object' || (user.id && user.id === 'anonymous')) {
      return false;
    }

    return true;
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
