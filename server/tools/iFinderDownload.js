import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';
import configCache from '../configCache.js';
import fs from 'fs';
import path from 'path';

/**
 * iFinder Download Tool
 * NOTE: The real iFinder API does not provide direct file download endpoints.
 * This tool retrieves document content through the document retrieval API
 * and can save it to local files if needed.
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
    downloadDir: iFinderConfig.downloadDir || config.IFINDER_DOWNLOAD_DIR || '/tmp/ifinder-downloads',
    timeout: iFinderConfig.timeout || config.IFINDER_TIMEOUT || 120000 // Longer timeout for downloads
  };
}

/**
 * Ensure download directory exists
 * @param {string} downloadDir - Directory path
 */
function ensureDownloadDirectory(downloadDir) {
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
}

/**
 * Get document content from iFinder (no direct download available)
 * @param {Object} params - Download parameters  
 * @param {string} params.documentId - Document ID to retrieve
 * @param {string} params.chatId - Chat session ID for tracking
 * @param {Object} params.user - Authenticated user object (injected by middleware)
 * @param {string} params.searchProfile - Search profile ID (optional, uses default if not specified)
 * @param {string} params.action - Action type ('content' or 'save') - default: 'content' 
 * @param {string} params.filename - Custom filename for saving (optional)
 * @returns {Object} Document content or saved file information
 */
export default async function iFinderDownload({ 
  documentId, 
  chatId, 
  user, 
  searchProfile,
  action = 'content',
  filename
}) {
  if (!documentId) {
    throw new Error('Document ID parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder document access requires authenticated user');
  }

  if (!['content', 'save'].includes(action)) {
    throw new Error('Action must be either "content" or "save"');
  }

  const finderConfig = getIFinderConfig();
  const profileId = searchProfile || finderConfig.defaultSearchProfile;
  
  // Track the action
  actionTracker.trackAction(chatId, { 
    action: 'ifinder_download', 
    documentId: documentId,
    searchProfile: profileId,
    downloadAction: action,
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

    if (action === 'content') {
      // Return document content info without saving
      console.log(`iFinder Download: Fetching document ${documentId} content info for user ${user.email || user.id}`);
      
      return {
        documentId: documentId,
        action: 'content',
        searchProfile: profileId,
        documentUrl: documentUrl,
        note: 'Real iFinder API does not support direct file downloads. Use the document URL to retrieve content.',
        authRequired: true,
        authorizationHeader: authHeader,
        instructions: 'Use iFinderContent tool to get the actual document content.',
        alternativeTools: ['iFinderContent', 'iFinderMetadata']
      };
    }

    // Server-side save of document content 
    console.log(`iFinder Download: Saving document ${documentId} content as user ${user.email || user.id}`);
    
    // Make API request to get document content
    const response = await throttledFetch(
      'iFinderDownload',
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
      
      throw new Error(`iFinder document fetch failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const doc = data.document || {};
    const apiMetadata = data.metadata || {};
    
    // Determine filename
    const actualFilename = filename || 
                          doc.filename || 
                          doc.title || 
                          `document_${documentId}.txt`;
    
    // Ensure download directory exists
    ensureDownloadDirectory(finderConfig.downloadDir);
    
    // Generate unique filename to avoid conflicts
    const timestamp = new Date().getTime();
    const safeFilename = actualFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const localFilename = `${timestamp}_${safeFilename}`;
    const localPath = path.join(finderConfig.downloadDir, localFilename);

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
      sizeFormatted: formatFileSize(contentBuffer.length),
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
    const metadataPath = path.join(finderConfig.downloadDir, metadataFilename);
    
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

    console.log(`iFinder Download: Successfully saved document ${documentId} content (${result.sizeFormatted})`);
    return result;

  } catch (error) {
    console.error('iFinder download error:', error);
    
    if (error.message.includes('JWT') || error.message.includes('authentication')) {
      throw new Error('iFinder authentication failed. Please check JWT configuration.');
    }
    
    if (error.message.includes('timeout')) {
      throw new Error('iFinder document request timed out. Document may be large or server is slow.');
    }
    
    if (error.message.includes('ENOSPC')) {
      throw new Error('Insufficient disk space for saving document.');
    }
    
    throw new Error(`iFinder document retrieval failed: ${error.message}`);
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
  const action = process.argv[3] || 'content';

  if (!documentId) {
    console.error('Usage: node iFinderDownload.js <document-id> [action]');
    console.error('Example: node iFinderDownload.js "doc123456" "save"');
    console.error('Actions: content (get content info), save (save content to file)');
    process.exit(1);
  }

  console.log(`iFinder document retrieval for document: ${documentId} (action: ${action})`);

  try {
    // Mock user for CLI testing
    const mockUser = {
      id: 'test-user',
      email: 'test@example.com',
      name: 'Test User',
      isAdmin: false,
      groups: ['users']
    };

    const result = await iFinderDownload({ 
      documentId: documentId, 
      user: mockUser,
      action: action,
      chatId: 'cli-test'
    });
    
    console.log('\niFinder Document Result:');
    console.log('=======================');
    console.log(`Document ID: ${result.documentId}`);
    console.log(`Action: ${result.action}`);
    
    if (result.action === 'content') {
      console.log(`Document URL: ${result.documentUrl}`);
      console.log(`Authorization Required: ${result.authRequired}`);
      console.log(`Note: ${result.note}`);
      console.log(`Alternative Tools: ${result.alternativeTools?.join(', ')}`);
    } else {
      console.log(`Status: ${result.success ? 'Success' : 'Failed'}`);
      console.log(`Title: ${result.title}`);
      console.log(`Filename: ${result.filename}`);
      console.log(`Size: ${result.sizeFormatted}`);
      console.log(`Content Length: ${result.contentLength} characters`);
      console.log(`Local Path: ${result.localPath}`);
      
      if (result.metadataFile) {
        console.log(`Metadata File: ${result.metadataFile.localPath}`);
      }
    }
    
  } catch (error) {
    console.error('Error with iFinder download:', error.message);
    process.exit(1);
  }
}