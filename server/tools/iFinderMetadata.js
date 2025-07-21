import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';

/**
 * iFinder Metadata Fetch Tool
 * Fetch detailed metadata for a specific document from iFinder
 */

/**
 * Get iFinder API configuration
 * @returns {Object} iFinder API configuration
 */
function getIFinderConfig() {
  return {
    baseUrl: config.IFINDER_API_URL || process.env.IFINDER_API_URL || 'https://api.ifinder.example.com',
    metadataEndpoint: config.IFINDER_METADATA_ENDPOINT || process.env.IFINDER_METADATA_ENDPOINT || '/api/v1/documents/{documentId}/metadata',
    timeout: config.IFINDER_TIMEOUT || 30000
  };
}

/**
 * Fetch metadata for a specific document
 * @param {Object} params - Metadata fetch parameters
 * @param {string} params.documentId - Document ID to fetch metadata for
 * @param {string} params.chatId - Chat session ID for tracking
 * @param {Object} params.user - Authenticated user object (injected by middleware)
 * @param {boolean} params.includePermissions - Include document permissions in metadata (default: false)
 * @param {boolean} params.includeVersions - Include version history in metadata (default: false)
 * @returns {Object} Document metadata
 */
export default async function iFinderMetadata({ documentId, chatId, user, includePermissions = false, includeVersions = false }) {
  if (!documentId) {
    throw new Error('Document ID parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder metadata access requires authenticated user');
  }

  const finderConfig = getIFinderConfig();
  
  // Track the action
  actionTracker.trackAction(chatId, { 
    action: 'ifinder_metadata', 
    documentId: documentId,
    user: user.id
  });

  try {
    // Generate JWT token for the user
    const authHeader = getIFinderAuthorizationHeader(user, { scope: 'fa_index_read' });
    
    // Construct metadata URL
    const metadataUrl = `${finderConfig.baseUrl}${finderConfig.metadataEndpoint.replace('{documentId}', encodeURIComponent(documentId))}`;
    
    // Add query parameters if specified
    const urlParams = new URLSearchParams();
    if (includePermissions) {
      urlParams.append('includePermissions', 'true');
    }
    if (includeVersions) {
      urlParams.append('includeVersions', 'true');
    }
    
    const finalUrl = urlParams.toString() ? `${metadataUrl}?${urlParams.toString()}` : metadataUrl;

    console.log(`iFinder Metadata: Fetching metadata for document ${documentId} as user ${user.email || user.id}`);
    
    // Make API request
    const response = await throttledFetch(
      'iFinderMetadata',
      finalUrl,
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
    
    // Process and normalize the metadata
    const metadata = {
      documentId: data.id || data.documentId || documentId,
      title: data.title || data.name,
      description: data.description || data.summary,
      documentType: data.documentType || data.type || data.mimeType,
      language: data.language,
      
      // File information
      filename: data.filename || data.fileName,
      size: data.size || data.fileSize,
      sizeFormatted: data.sizeFormatted || formatFileSize(data.size),
      mimeType: data.mimeType || data.contentType,
      
      // Timestamps
      createdDate: data.createdDate || data.created,
      lastModified: data.lastModified || data.modified,
      indexedDate: data.indexedDate || data.indexed,
      
      // Author/ownership
      author: data.author || data.creator,
      owner: data.owner,
      
      // Content information
      pageCount: data.pageCount || data.pages,
      wordCount: data.wordCount || data.words,
      
      // URLs and paths
      url: data.url || data.accessUrl,
      downloadUrl: data.downloadUrl,
      thumbnailUrl: data.thumbnailUrl || data.preview,
      
      // Custom metadata
      customMetadata: data.customMetadata || data.metadata || {},
      
      // Tags and categories
      tags: data.tags || [],
      categories: data.categories || [],
      
      // Access information (if requested)
      ...(includePermissions && {
        permissions: {
          canRead: data.permissions?.canRead !== false,
          canWrite: data.permissions?.canWrite || false,
          canDelete: data.permissions?.canDelete || false,
          canShare: data.permissions?.canShare || false
        }
      }),
      
      // Version information (if requested)
      ...(includeVersions && {
        versions: data.versions || [],
        currentVersion: data.currentVersion || data.version
      })
    };

    console.log(`iFinder Metadata: Successfully fetched metadata for document ${documentId}`);
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
      chatId: 'cli-test',
      includePermissions: true,
      includeVersions: true
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
    
    if (result.permissions) {
      console.log('\nPermissions:');
      console.log(`  Can Read: ${result.permissions.canRead}`);
      console.log(`  Can Write: ${result.permissions.canWrite}`);
      console.log(`  Can Delete: ${result.permissions.canDelete}`);
      console.log(`  Can Share: ${result.permissions.canShare}`);
    }
    
  } catch (error) {
    console.error('Error fetching iFinder metadata:', error.message);
    process.exit(1);
  }
}