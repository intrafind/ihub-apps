import { actionTracker } from '../../actionTracker.js';
import config from '../../config.js';
import { throttledFetch } from '../../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import configCache from '../../configCache.js';
import authDebugService from '../../utils/authDebugService.js';
import fs from 'fs';
import path from 'path';

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
          iFinderConfig.defaultSearchProfile || process.env.IFINDER_SEARCH_PROFILE || 'default',
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

    console.log(
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
        console.error(
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

      // Normalize result format
      if (data.results && Array.isArray(data.results)) {
        results.results = data.results.map(hit => {
          const doc = hit.document || {};
          const metadata = hit.metadata || {};

          return {
            // Document identification
            id: doc.id,
            score: metadata.score,

            // Basic document fields
            title: doc.title,
            content: doc.content,
            url: doc.url || metadata.url,
            filename: doc.filename || doc.file?.name,
            source: doc.source || doc.sourceName || metadata.sourceName,
            breadcrumbs: doc.navigationTree || metadata.navigationTree || [],

            // Document text fields
            description_texts: doc.description_texts || [],
            summary_texts: doc.summary_texts || [],
            application: doc.application || metadata.application,

            // Document metadata fields
            documentType: doc.documentType || doc.type,
            mimeType: doc.mimeType || doc.mediaType,
            language: doc.language || metadata.language,
            size: doc.size,
            author: doc.author || doc.creator,
            createdDate: doc.createdDate || doc.created,
            lastModified: doc.lastModified || doc.modified,

            // Search-specific metadata
            teasers: metadata.teasers || []

            // Raw document data for advanced use
            // TODO: we should pass them, but remove the ones we have already extracted, so we save space
            // rawDocument: doc,
            // rawMetadata: metadata
          };
        });
      }

      console.log(
        `iFinder Search: Found ${results.totalFound} results in ${results.took || 'unknown time'}`
      );
      // console.log('iFinder Search: Results:', JSON.stringify(results, null, 2));
      return results;
    } catch (error) {
      console.error('iFinder search error:', error);
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

      console.log(
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
        console.warn(`iFinder Content: No content extracted for document ${documentId}`);
      } else if (result.content.length > maxLength) {
        console.warn(`iFinder Content: Content truncated to ${maxLength} characters`);
        result.content = result.content.substring(0, maxLength) + '... [Content truncated]';
        result.truncated = true;
      }

      console.log(
        `iFinder Content: Successfully fetched ${result.contentLength} characters for document ${documentId}`
      );
      return result;
    } catch (error) {
      console.error('iFinder content fetch error:', error);
      this._handleError(error);
    }
  }

  /**
   * Fetch metadata for a specific document
   * @param {Object} params - Metadata fetch parameters
   * @returns {Object} Document metadata
   */
  async getMetadata({ documentId, chatId, user, searchProfile }) {
    if (!documentId) {
      throw new Error('Document ID parameter is required');
    }
    this.validateCommon(user, chatId);

    const config = this.getConfig();
    const profileId = searchProfile || config.defaultSearchProfile;

    // Track the action
    actionTracker.trackAction(chatId, {
      action: 'ifinder_metadata',
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

      console.log(
        `iFinder Metadata: Fetching document ${documentId} from profile "${profileId}" as user ${user.email || user.id}`
      );

      // Make API request
      const response = await throttledFetch('iFinderMetadata', documentUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        },
        timeout: config.timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 404) throw new Error(`Document not found: ${documentId}`);
        if (response.status === 403) throw new Error(`Access denied to document: ${documentId}`);
        throw new Error(
          `iFinder metadata fetch failed with status ${response.status}: ${errorText}`
        );
      }

      const data = await response.json();
      const doc = data.document || {};
      const apiMetadata = data.metadata || {};

      const metadata = {
        // API response metadata
        searchProfile: profileId,
        took: apiMetadata.took,

        // Document identification
        documentId: doc.id || documentId,

        // Basic document fields
        title: doc.title,
        content: doc.content,
        url: doc.url,
        filename: doc.filename,

        // Document metadata fields
        documentType: doc.documentType || doc.type,
        mimeType: doc.mimeType,
        language: doc.language,
        size: doc.size,
        sizeFormatted: this._formatFileSize(doc.size),

        // Timestamps
        createdDate: doc.createdDate || doc.created,
        lastModified: doc.lastModified || doc.modified,
        indexedDate: doc.indexedDate || doc.indexed,

        // Author/ownership
        author: doc.author || doc.creator,
        owner: doc.owner,

        // Content information
        pageCount: doc.pageCount || doc.pages,
        wordCount: doc.wordCount || doc.words,

        // Additional URLs
        downloadUrl: doc.downloadUrl,
        thumbnailUrl: doc.thumbnailUrl || doc.preview,

        // Tags and categories
        tags: doc.tags || [],
        categories: doc.categories || [],

        // Raw document data
        rawDocument: doc,
        rawApiMetadata: apiMetadata
      };

      console.log(
        `iFinder Metadata: Successfully fetched document ${documentId} metadata in ${metadata.took || 'unknown time'}`
      );
      return metadata;
    } catch (error) {
      console.error('iFinder metadata fetch error:', error);
      this._handleError(error);
    }
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
        console.log(
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
      console.log(
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

      console.log(
        `iFinder Download: Successfully saved document ${documentId} content (${result.sizeFormatted})`
      );
      return result;
    } catch (error) {
      console.error('iFinder download error:', error);
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
