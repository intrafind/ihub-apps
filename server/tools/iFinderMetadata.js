import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';
import configCache from '../configCache.js';

/**
 * iFinder Metadata Fetch Tool
 * Fetch detailed metadata for a specific document from iFinder
 */

/**
 * Get iFinder API configuration
 * @returns {Object} iFinder API configuration
 */
function getIFinderConfig() {
  const platform = configCache.getPlatform() || {};
  const iFinderConfig = platform.iFinder || {};
  
  return {
    baseUrl: config.IFINDER_API_URL || process.env.IFINDER_API_URL || iFinderConfig.baseUrl || 'https://api.ifinder.example.com',
    documentEndpoint: iFinderConfig.endpoints?.document || '/public-api/retrieval/api/v1/search-profiles/{profileId}/docs/{docId}',
    defaultSearchProfile: iFinderConfig.defaultSearchProfile || process.env.IFINDER_SEARCH_PROFILE || 'default',
    timeout: iFinderConfig.timeout || config.IFINDER_TIMEOUT || 30000
  };
}

/**
 * Fetch metadata for a specific document
 * @param {Object} params - Metadata fetch parameters
 * @param {string} params.documentId - Document ID to fetch metadata for
 * @param {string} params.chatId - Chat session ID for tracking
 * @param {Object} params.user - Authenticated user object (injected by middleware)
 * @param {string} params.searchProfile - Search profile ID (optional, uses default if not specified)
 * @returns {Object} Document metadata
 */
export default async function iFinderMetadata({ documentId, chatId, user, searchProfile }) {
  if (!documentId) {
    throw new Error('Document ID parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder metadata access requires authenticated user');
  }

  const finderConfig = getIFinderConfig();
  const profileId = searchProfile || finderConfig.defaultSearchProfile;
  
  // Track the action
  actionTracker.trackAction(chatId, { 
    action: 'ifinder_metadata', 
    documentId: documentId,
    searchProfile: profileId,
    user: user.id
  });

  try {
    // Generate JWT token for the user
    const authHeader = getIFinderAuthorizationHeader(user, { scope: 'fa_index_read' });
    
    // Construct document URL with profile ID and document ID
    const documentEndpoint = finderConfig.documentEndpoint
      .replace('{profileId}', encodeURIComponent(profileId))
      .replace('{docId}', encodeURIComponent(documentId));
    const documentUrl = `${finderConfig.baseUrl}${documentEndpoint}`;

    console.log(`iFinder Metadata: Fetching document ${documentId} from profile "${profileId}" as user ${user.email || user.id}`);
    
    // Make API request
    const response = await throttledFetch(
      'iFinderMetadata',
      documentUrl,
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json'
        },
        timeout: finderConfig.timeout
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      
      if (response.status === 404) {
        throw new Error(`Document not found: ${documentId}`);
      }
      if (response.status === 403) {
        throw new Error(`Access denied to document: ${documentId}`);
      }
      
      throw new Error(`iFinder metadata fetch failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // Process and normalize the metadata from RetrievalResult format
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
      sizeFormatted: formatFileSize(doc.size),
      
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
      
      // Raw document data for advanced use
      rawDocument: doc,
      rawApiMetadata: apiMetadata
    };

    console.log(`iFinder Metadata: Successfully fetched document ${documentId} metadata in ${metadata.took || 'unknown time'}`);
    return metadata;

  } catch (error) {
    console.error('iFinder metadata fetch error:', error);
    
    if (error.message.includes('JWT') || error.message.includes('authentication')) {
      throw new Error('iFinder authentication failed. Please check JWT configuration.');
    }
    
    if (error.message.includes('timeout')) {
      throw new Error('iFinder metadata request timed out. Please try again.');
    }
    
    throw new Error(`iFinder metadata fetch failed: ${error.message}`);
  }
}

/**
 * Format file size in human readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const documentId = process.argv[2];

  if (!documentId) {
    console.error('Usage: node iFinderMetadata.js <document-id>');
    console.error('Example: node iFinderMetadata.js "doc123456"');
    process.exit(1);
  }

  console.log(`Fetching iFinder metadata for document: ${documentId}`);

  try {
    // Mock user for CLI testing
    const mockUser = {
      id: 'test-user',
      email: 'test@example.com',
      name: 'Test User',
      isAdmin: false,
      groups: ['users']
    };

    const result = await iFinderMetadata({ 
      documentId: documentId, 
      user: mockUser,
      chatId: 'cli-test'
    });
    
    console.log('\niFinder Document Metadata:');
    console.log('=========================');
    console.log(`Title: ${result.title}`);
    console.log(`Document ID: ${result.documentId}`);
    console.log(`Type: ${result.documentType}`);
    console.log(`Size: ${result.sizeFormatted || result.size}`);
    console.log(`Author: ${result.author}`);
    console.log(`Created: ${result.createdDate}`);
    console.log(`Modified: ${result.lastModified}`);
    
    if (result.url) {
      console.log(`URL: ${result.url}`);
    }
    
    if (result.tags && result.tags.length > 0) {
      console.log(`Tags: ${result.tags.join(', ')}`);
    }
    
    if (result.took) {
      console.log(`Fetch Time: ${result.took}`);
    }
    
  } catch (error) {
    console.error('Error fetching iFinder metadata:', error.message);
    process.exit(1);
  }
}