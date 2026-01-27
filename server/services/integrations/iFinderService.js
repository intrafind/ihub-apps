import { actionTracker } from '../../actionTracker.js';
import config from '../../config.js';
import { throttledFetch } from '../../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import configCache from '../../configCache.js';
import authDebugService from '../../utils/authDebugService.js';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

/**
 * Unified iFinder Service Class
 * Provides search, content retrieval, metadata fetching, and download functionality
 * for the iFinder document management system.
 */

class IFinderService {
  constructor() {
    this.platform = null;
    this.config = null;
  }

  /**
   * Get iFinder API configuration
   * @returns {Object} iFinder API configuration
   */
  getConfig() {
    if (!this.config) {
      this.platform = configCache.getPlatform() || {};
      const iFinderConfig = this.platform.iFinder || {};

      this.config = {
        baseUrl:
          config.IFINDER_API_URL ||
          process.env.IFINDER_API_URL ||
          iFinderConfig.baseUrl ||
          'https://api.ifinder.example.com',
        endpoints: {
          search:
            iFinderConfig.endpoints?.search ||
            '/public-api/retrieval/api/v1/search-profiles/{profileId}/_search',
          document:
            iFinderConfig.endpoints?.document ||
            '/public-api/retrieval/api/v1/search-profiles/{profileId}/docs/{docId}'
        },
        defaultSearchProfile:
          iFinderConfig.defaultSearchProfile ||
          process.env.IFINDER_SEARCH_PROFILE ||
          'searchprofile-standard',
        downloadDir:
          iFinderConfig.downloadDir || config.IFINDER_DOWNLOAD_DIR || '/tmp/ifinder-downloads',
        timeout: iFinderConfig.timeout || config.IFINDER_TIMEOUT || 30000
      };
    }
    return this.config;
  }

  /**
   * Validate common parameters
   * @param {Object} user - User object
   * @param {string} chatId - Chat ID for tracking
   */
  validateCommon(user, chatId) {
    if (!user || user.id === 'anonymous') {
      throw new Error('iFinder access requires authenticated user');
    }
    if (!chatId) {
      throw new Error('Chat ID is required for tracking');
    }
  }

  /**
   * Search for documents in iFinder
   * @param {Object} params - Search parameters
   * @returns {Object} Search results
   */
  async search({
    query,
    chatId,
    user,
    maxResults = 10,
    searchProfile,
    returnFields = [
      'id',
      'mediaType',
      'sourceName',
      'title',
      'navigationTree',
      'description_texts',
      'summary_texts',
      'application',
      'url',
      'language',
      'file.name',
      'contentLength'
    ],
    returnFacets,
    sort
  }) {
    if (!query) {
      throw new Error('Query parameter is required');
    }
    this.validateCommon(user, chatId);

    const config = this.getConfig();
    const profileId = searchProfile || config.defaultSearchProfile;

    logger.info(
      `iFinder Search: User ${JSON.stringify(user)}searching for "${query}" in profile "${profileId}"`
    );

    // Track the action
    actionTracker.trackAction(chatId, {
      action: 'ifinder_search',
      query: query,
      searchProfile: profileId,
      user: user.email
    });

    try {
      // Generate JWT token for the user
      const authHeader = getIFinderAuthorizationHeader(user);

      // Log authentication header with proper masking
      authDebugService.log('iFinder', 'info', 'JWT token generated for search request', {
        userId: user.id,
        userName: user.name,
        userGroups: user.groups,
        authHeader: authHeader,
        searchProfile: profileId
      });

      // Construct search URL with profile ID
      const searchEndpoint = config.endpoints.search.replace(
        '{profileId}',
        encodeURIComponent(profileId)
      );
      const baseUrl = `${config.baseUrl}${searchEndpoint}`;

      // Build query parameters
      const params = new URLSearchParams();
      if (query) params.append('query', query);
      params.append('size', Math.min(maxResults, 100).toString());

      if (returnFields && returnFields.length > 0) {
        returnFields.forEach(field => params.append('return_fields', field));
      }

      if (returnFacets && returnFacets.length > 0) {
        returnFacets.forEach(facet => params.append('return_facets', facet));
      }

      if (sort && sort.length > 0) {
        sort.forEach(sortCriteria => params.append('sort', sortCriteria));
      }

      const searchUrl = `${baseUrl}?${params.toString()}`;

      // Make API request
      const response = await throttledFetch('iFinderSearch', searchUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        },
        timeout: config.timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          `iFinder Search: Error fetching results for "${query}" in profile "${profileId}":`,
          errorText
        );
        throw new Error(`iFinder search failed with status ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      // Process and normalize the results
      const results = {
        query: query,
        searchProfile: profileId,
        metadata: data.metadata || {},
        totalFound: data.metadata?.total_hits || (data.results ? data.results.length : 0),
        took: data.metadata?.took,
        results: [],
        facets: data.facets || null
      };

      // Helper function to get array field values (iFinder returns most fields as arrays)
      const getFieldValue = (doc, fieldName, defaultValue = null) => {
        const value = doc[fieldName];
        if (Array.isArray(value)) {
          return value.length === 1 ? value[0] : value;
        }
        return value || defaultValue;
      };

      // Helper function to get nested dot-notation fields and group them
      const getNestedFields = (doc, prefix) => {
        const nested = {};
        Object.keys(doc).forEach(key => {
          if (key.startsWith(prefix + '.')) {
            const subKey = key.substring(prefix.length + 1);
            nested[subKey] = getFieldValue(doc, key);
          }
        });
        return Object.keys(nested).length > 0 ? nested : null;
      };

      // Normalize result format with enhanced field processing
      if (data.results && Array.isArray(data.results)) {
        results.results = data.results.map(hit => {
          const doc = hit.document || {};
          const hitMetadata = hit.metadata || {};

          return {
            // Document identification
            id: getFieldValue(doc, 'id'),
            score: hitMetadata.score,

            // Basic document fields (iFinder returns these as arrays)
            title: getFieldValue(doc, 'title'),
            sourceName: getFieldValue(doc, 'sourceName'),
            language: getFieldValue(doc, 'language'),
            mediaType: getFieldValue(doc, 'mediaType'),
            sourceType: getFieldValue(doc, 'sourceType'),
            application: getFieldValue(doc, 'application'),
            contentLength: getFieldValue(doc, 'contentLength'),

            // Timestamps (iFinder format)
            modificationDate: getFieldValue(doc, 'modificationDate'),
            indexingDate: getFieldValue(doc, 'indexingDate'),

            // Navigation (iFinder returns as array)
            navigationTree: getFieldValue(doc, 'navigationTree', []),

            // Nested objects from dot-notation fields
            accessInfo: getNestedFields(doc, 'accessInfo'),
            file: getNestedFields(doc, 'file'),
            sourceLocations: {
              url: getFieldValue(doc, 'sourceLocations.url', []),
              label: getFieldValue(doc, 'sourceLocations.label', [])
            },

            // Backward compatibility fields
            filename: getFieldValue(doc, 'file.name'),
            size: getFieldValue(doc, 'file.size'),
            extension: getFieldValue(doc, 'file.extension'),
            sizeFormatted: this._formatFileSize(
              getFieldValue(doc, 'file.size') || getFieldValue(doc, 'contentLength')
            ),

            // Legacy/fallback fields for backward compatibility
            url: getFieldValue(doc, 'url'),
            deepLink: getFieldValue(doc, 'accessInfo.deepLink'),
            documentType: getFieldValue(doc, 'documentType'),
            mimeType: getFieldValue(doc, 'mediaType'), // Legacy alias
            content: getFieldValue(doc, 'content'),
            source: getFieldValue(doc, 'sourceName'), // Legacy alias
            breadcrumbs: getFieldValue(doc, 'navigationTree', []), // Legacy alias
            createdDate: getFieldValue(doc, 'createdDate'),
            lastModified:
              getFieldValue(doc, 'lastModified') || getFieldValue(doc, 'modificationDate'),
            author: getFieldValue(doc, 'author'),
            owner: getFieldValue(doc, 'owner'),

            // Document text fields (if available)
            description_texts: getFieldValue(doc, 'description_texts', []),
            summary_texts: getFieldValue(doc, 'summary_texts', []),

            // Search-specific metadata
            teasers: hitMetadata.teasers || [],

            // Raw document data
            rawDocument: doc,
            rawHitMetadata: hitMetadata
          };
        });
      }

      logger.info(
        `iFinder Search: Found ${results.totalFound} results in ${results.took || 'unknown time'}`
      );
      // logger.info('iFinder Search: Results:', JSON.stringify(results, null, 2));
      return results;
    } catch (error) {
      logger.error('iFinder search error:', error);
      this._handleError(error);
    }
  }

  /**
   * Fetch document content for LLM processing
   * @param {Object} params - Content fetch parameters
   * @returns {Object} Document content and metadata
   */
  async getContent({ documentId, chatId, user, searchProfile, maxLength = 50000 }) {
    if (!documentId) {
      throw new Error('Document ID parameter is required');
    }
    this.validateCommon(user, chatId);

    const config = this.getConfig();
    const profileId = searchProfile || config.defaultSearchProfile;

    // Track the action
    actionTracker.trackAction(chatId, {
      action: 'ifinder_content',
      documentId: documentId,
      searchProfile: profileId,
      user: user.email
    });

    try {
      // Generate JWT token for the user
      const authHeader = getIFinderAuthorizationHeader(user);

      // Construct document URL
      const documentEndpoint = config.endpoints.document
        .replace('{profileId}', encodeURIComponent(profileId))
        .replace('{docId}', encodeURIComponent(documentId));
      const documentUrl = `${config.baseUrl}${documentEndpoint}`;

      logger.info(
        `iFinder Content: Fetching content for document ${documentId} from profile "${profileId}" as user ${user.email || user.id}`
      );

      // Make API request
      const response = await throttledFetch('iFinderContent', documentUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        },
        timeout: config.timeout + 30000 // Longer timeout for content fetch
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 404) throw new Error(`Document not found: ${documentId}`);
        if (response.status === 403)
          throw new Error(`Access denied to document content: ${documentId}`);
        if (response.status === 413)
          throw new Error(`Document content too large. Try reducing maxLength.`);
        throw new Error(
          `iFinder content fetch failed with status ${response.status}: ${errorText}`
        );
      }

      const data = await response.json();
      const doc = data.document || {};
      const apiMetadata = data.metadata || {};
      const content = doc.content || '';

      const result = {
        // API response metadata
        searchProfile: profileId,
        took: apiMetadata.took,

        // Document identification
        documentId: doc.id || documentId,

        // Content information
        content: content,
        contentLength: content.length,
        contentLengthFormatted: this._formatContentLength(content.length),

        // Document metadata
        metadata: {
          title: doc.title,
          documentType: doc.documentType || doc.type,
          mimeType: doc.mimeType,
          language: doc.language,
          size: doc.size,
          author: doc.author || doc.creator,
          createdDate: doc.createdDate || doc.created,
          lastModified: doc.lastModified || doc.modified,
          filename: doc.filename,
          url: doc.url
        },

        // Raw document data
        rawDocument: doc,
        rawApiMetadata: apiMetadata
      };

      // Validate and truncate content if necessary
      if (result.content.length === 0) {
        logger.warn(`iFinder Content: No content extracted for document ${documentId}`);
      } else if (result.content.length > maxLength) {
        logger.warn(`iFinder Content: Content truncated to ${maxLength} characters`);
        result.content = result.content.substring(0, maxLength) + '... [Content truncated]';
        result.truncated = true;
      }

      logger.info(
        `iFinder Content: Successfully fetched ${result.contentLength} characters for document ${documentId}`
      );
      return result;
    } catch (error) {
      logger.error('iFinder content fetch error:', error);
      this._handleError(error);
    }
  }

  /**
   * Fetch metadata for a specific document using search endpoint
   * @param {Object} params - Metadata fetch parameters
   * @returns {Object} Document metadata
   */
  async getMetadata({
    documentId,
    chatId,
    user,
    searchProfile,
    returnFields = [
      'title',
      'language',
      'accessInfo.*',
      'mediaType',
      'sourceType',
      'file.*',
      'sourceLocations.*',
      'navigationTree',
      'modificationDate',
      'indexingDate',
      'application',
      'contentLength',
      'sourceName'
    ]
  }) {
    if (!documentId) {
      throw new Error('Document ID parameter is required');
    }

    // Use the search method with _id:documentId query
    const searchResult = await this.search({
      query: `_id:${documentId}`,
      chatId,
      user,
      maxResults: 1,
      searchProfile,
      returnFields
    });

    // Check if document was found
    if (!searchResult.results || searchResult.results.length === 0) {
      throw new Error(`Document not found: ${documentId}`);
    }

    // Get the single result and enhance it for metadata use case
    const result = searchResult.results[0];

    // Add metadata-specific fields and logging
    const metadata = {
      ...result,
      // Ensure we have the document ID
      documentId: result.id || documentId,

      // Add search metadata
      searchProfile: searchResult.searchProfile,
      took: searchResult.took,
      totalFound: searchResult.totalFound,

      // Keep raw data from search result
      rawSearchResult: searchResult
    };

    logger.info(
      `iFinder Metadata: Successfully fetched document ${documentId} metadata in ${metadata.took || 'unknown time'} (score: ${metadata.score})`
    );

    return metadata;
  }

  /**
   * Download/save document content locally
   * @param {Object} params - Download parameters
   * @returns {Object} Download result or content info
   */
  async download({ documentId, chatId, user, searchProfile, action = 'content', filename }) {
    if (!documentId) {
      throw new Error('Document ID parameter is required');
    }
    this.validateCommon(user, chatId);

    if (!['content', 'save'].includes(action)) {
      throw new Error('Action must be either "content" or "save"');
    }

    const config = this.getConfig();
    const profileId = searchProfile || config.defaultSearchProfile;

    // Track the action
    actionTracker.trackAction(chatId, {
      action: 'ifinder_download',
      documentId: documentId,
      searchProfile: profileId,
      downloadAction: action,
      user: user.email
    });

    try {
      // Generate JWT token for the user
      const authHeader = getIFinderAuthorizationHeader(user);

      // Construct document URL
      const documentEndpoint = config.endpoints.document
        .replace('{profileId}', encodeURIComponent(profileId))
        .replace('{docId}', encodeURIComponent(documentId));
      const documentUrl = `${config.baseUrl}${documentEndpoint}`;

      if (action === 'content') {
        // Return document content info without saving
        logger.info(
          `iFinder Download: Fetching document ${documentId} content info for user ${user.email || user.id}`
        );

        return {
          documentId: documentId,
          action: 'content',
          searchProfile: profileId,
          documentUrl: documentUrl,
          note: 'Real iFinder API does not support direct file downloads. Use the document URL to retrieve content.',
          authRequired: true,
          authorizationHeader: authHeader,
          instructions: 'Use iFinder.getContent tool to get the actual document content.',
          alternativeTools: ['iFinder.getContent', 'iFinder.getMetadata']
        };
      }

      // Server-side save of document content
      logger.info(
        `iFinder Download: Saving document ${documentId} content as user ${user.email || user.id}`
      );

      // Make API request to get document content
      const response = await throttledFetch('iFinderDownload', documentUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        },
        timeout: config.timeout + 90000 // Longer timeout for downloads
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 404) throw new Error(`Document not found: ${documentId}`);
        if (response.status === 403) throw new Error(`Access denied to document: ${documentId}`);
        throw new Error(
          `iFinder document fetch failed with status ${response.status}: ${errorText}`
        );
      }

      const data = await response.json();
      const doc = data.document || {};
      const apiMetadata = data.metadata || {};

      // Determine filename
      const actualFilename = filename || doc.filename || doc.title || `document_${documentId}.txt`;

      // Ensure download directory exists
      this._ensureDownloadDirectory(config.downloadDir);

      // Generate unique filename to avoid conflicts
      const timestamp = new Date().getTime();
      const safeFilename = actualFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
      const localFilename = `${timestamp}_${safeFilename}`;
      const localPath = path.join(config.downloadDir, localFilename);

      // Save document content to local storage
      const content = doc.content || '';
      const contentBuffer = Buffer.from(content, 'utf8');
      fs.writeFileSync(localPath, contentBuffer);

      const result = {
        documentId: documentId,
        action: 'save',
        success: true,
        searchProfile: profileId,
        took: apiMetadata.took,

        // File information
        filename: actualFilename,
        localFilename: localFilename,
        localPath: localPath,
        size: contentBuffer.length,
        sizeFormatted: this._formatFileSize(contentBuffer.length),
        savedAt: new Date().toISOString(),

        // Document information from API
        title: doc.title,
        documentType: doc.documentType || doc.type,
        mimeType: doc.mimeType,
        language: doc.language,
        author: doc.author,

        // Content metadata
        contentLength: content.length,
        hasContent: content.length > 0,

        // API metadata
        temporaryFile: true,
        note: 'Document content saved as text file. Real iFinder API does not provide original file downloads.'
      };

      // Optionally save metadata file
      const metadataFilename = `${timestamp}_${documentId}_metadata.json`;
      const metadataPath = path.join(config.downloadDir, metadataFilename);

      const metadata = {
        documentId: doc.id || documentId,
        title: doc.title,
        documentType: doc.documentType,
        language: doc.language,
        author: doc.author,
        size: doc.size,
        retrievedAt: new Date().toISOString(),
        searchProfile: profileId,
        apiMetadata: apiMetadata
      };

      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      result.metadataFile = {
        filename: metadataFilename,
        localPath: metadataPath
      };

      logger.info(
        `iFinder Download: Successfully saved document ${documentId} content (${result.sizeFormatted})`
      );
      return result;
    } catch (error) {
      logger.error('iFinder download error:', error);
      this._handleError(error);
    }
  }

  /**
   * Ensure download directory exists
   * @param {string} downloadDir - Directory path
   */
  _ensureDownloadDirectory(downloadDir) {
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
  }

  /**
   * Format content length in human readable format
   * @param {number} length - Content length in characters
   * @returns {string} Formatted content length
   */
  _formatContentLength(length) {
    if (length < 1000) {
      return `${length} characters`;
    } else if (length < 1000000) {
      return `${Math.round((length / 1000) * 10) / 10}K characters`;
    } else {
      return `${Math.round((length / 1000000) * 10) / 10}M characters`;
    }
  }

  /**
   * Format file size in human readable format
   * @param {number} bytes - File size in bytes
   * @returns {string} Formatted file size
   */
  _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Handle errors consistently across all methods
   * @param {Error} error - The error to handle
   */
  _handleError(error) {
    if (error.message.includes('JWT') || error.message.includes('authentication')) {
      throw new Error('iFinder authentication failed. Please check JWT configuration.');
    }

    if (error.message.includes('timeout')) {
      throw new Error('iFinder request timed out. Please try again.');
    }

    if (error.message.includes('ENOSPC')) {
      throw new Error('Insufficient disk space for saving document.');
    }

    throw new Error(`iFinder operation failed: ${error.message}`);
  }
}

// Export singleton instance
export default new IFinderService();
