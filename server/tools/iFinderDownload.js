import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';
import fs from 'fs';
import path from 'path';

/**
 * iFinder Download Tool
 * Download documents from iFinder or provide download URLs
 */

/**
 * Get iFinder API configuration
 * @returns {Object} iFinder API configuration
 */
function getIFinderConfig() {
  return {
    baseUrl: config.IFINDER_API_URL || process.env.IFINDER_API_URL || 'https://api.ifinder.example.com',
    downloadEndpoint: config.IFINDER_DOWNLOAD_ENDPOINT || process.env.IFINDER_DOWNLOAD_ENDPOINT || '/api/v1/documents/{documentId}/download',
    downloadDir: config.IFINDER_DOWNLOAD_DIR || process.env.IFINDER_DOWNLOAD_DIR || '/tmp/ifinder-downloads',
    timeout: config.IFINDER_TIMEOUT || 120000 // Longer timeout for downloads
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
 * Download document from iFinder
 * @param {Object} params - Download parameters
 * @param {string} params.documentId - Document ID to download
 * @param {string} params.chatId - Chat session ID for tracking
 * @param {Object} params.user - Authenticated user object (injected by middleware)
 * @param {string} params.action - Action type ('download' or 'url') - default: 'url'
 * @param {string} params.filename - Custom filename for download (optional)
 * @param {boolean} params.includeMetadata - Include metadata file with download (default: false)
 * @returns {Object} Download result with URL or file information
 */
export default async function iFinderDownload({ 
  documentId, 
  chatId, 
  user, 
  action = 'url',
  filename,
  includeMetadata = false
}) {
  if (!documentId) {
    throw new Error('Document ID parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder download requires authenticated user');
  }

  if (!['download', 'url'].includes(action)) {
    throw new Error('Action must be either "download" or "url"');
  }

  const finderConfig = getIFinderConfig();
  
  // Track the action
  actionTracker.trackAction(chatId, { 
    action: 'ifinder_download', 
    documentId: documentId,
    downloadAction: action,
    user: user.id
  });

  try {
    // Generate JWT token for the user
    const authHeader = getIFinderAuthorizationHeader(user, { scope: 'fa_index_read' });
    
    // Construct download URL
    const downloadUrl = `${finderConfig.baseUrl}${finderConfig.downloadEndpoint.replace('{documentId}', encodeURIComponent(documentId))}`;

    if (action === 'url') {
      // Return URL for client-side download
      console.log(`iFinder Download: Generated download URL for document ${documentId} for user ${user.email || user.id}`);
      
      return {
        documentId: documentId,
        action: 'url',
        downloadUrl: downloadUrl,
        authRequired: true,
        authorizationHeader: authHeader,
        instructions: 'Use the provided URL and authorization header to download the document.',
        expiresIn: '1 hour', // JWT token expiration
        note: 'This URL requires the Authorization header for access.'
      };
    }

    // Server-side download
    console.log(`iFinder Download: Downloading document ${documentId} as user ${user.email || user.id}`);
    
    // Make API request to get download info first
    const infoResponse = await throttledFetch(
      'iFinderDownloadInfo',
      `${downloadUrl}?info=true`,
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json'
        },
        timeout: 10000 // Shorter timeout for info request
      }
    );

    if (!infoResponse.ok) {
      const errorText = await infoResponse.text();
      
      if (infoResponse.status === 404) {
        throw new Error(`Document not found: ${documentId}`);
      }
      if (infoResponse.status === 403) {
        throw new Error(`Download access denied for document: ${documentId}`);
      }
      
      throw new Error(`iFinder download info request failed with status ${infoResponse.status}: ${errorText}`);
    }

    const downloadInfo = await infoResponse.json();
    
    // Determine filename
    const actualFilename = filename || 
                          downloadInfo.filename || 
                          downloadInfo.originalFilename || 
                          `document_${documentId}`;
    
    // Ensure download directory exists
    ensureDownloadDirectory(finderConfig.downloadDir);
    
    // Generate unique filename to avoid conflicts
    const timestamp = new Date().getTime();
    const safeFilename = actualFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const localFilename = `${timestamp}_${safeFilename}`;
    const localPath = path.join(finderConfig.downloadDir, localFilename);

    // Download the actual file
    const downloadResponse = await throttledFetch(
      'iFinderDownload',
      downloadUrl,
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader
        },
        timeout: finderConfig.timeout
      }
    );

    if (!downloadResponse.ok) {
      throw new Error(`Document download failed with status ${downloadResponse.status}`);
    }

    // Save file to local storage
    const arrayBuffer = await downloadResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(localPath, buffer);

    const result = {
      documentId: documentId,
      action: 'download',
      success: true,
      
      // File information
      filename: actualFilename,
      localFilename: localFilename,
      localPath: localPath,
      size: buffer.length,
      sizeFormatted: formatFileSize(buffer.length),
      downloadedAt: new Date().toISOString(),
      
      // Document information from API
      documentType: downloadInfo.documentType || downloadInfo.mimeType,
      mimeType: downloadInfo.mimeType,
      originalFilename: downloadInfo.originalFilename,
      
      // Download metadata
      downloadUrl: downloadUrl,
      temporaryFile: true,
      note: 'File saved temporarily on server. Consider accessing via URL for direct client download.'
    };

    // Optionally save metadata file
    if (includeMetadata && downloadInfo.metadata) {
      const metadataFilename = `${timestamp}_${documentId}_metadata.json`;
      const metadataPath = path.join(finderConfig.downloadDir, metadataFilename);
      
      fs.writeFileSync(metadataPath, JSON.stringify(downloadInfo.metadata, null, 2));
      
      result.metadataFile = {
        filename: metadataFilename,
        localPath: metadataPath
      };
    }

    console.log(`iFinder Download: Successfully downloaded document ${documentId} (${result.sizeFormatted})`);
    return result;

  } catch (error) {
    console.error('iFinder download error:', error);
    
    if (error.message.includes('JWT') || error.message.includes('authentication')) {
      throw new Error('iFinder authentication failed. Please check JWT configuration.');
    }
    
    if (error.message.includes('timeout')) {
      throw new Error('iFinder download request timed out. Document may be large or server is slow.');
    }
    
    if (error.message.includes('ENOSPC')) {
      throw new Error('Insufficient disk space for download.');
    }
    
    throw new Error(`iFinder download failed: ${error.message}`);
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
  const action = process.argv[3] || 'url';

  if (!documentId) {
    console.error('Usage: node iFinderDownload.js <document-id> [action]');
    console.error('Example: node iFinderDownload.js "doc123456" "download"');
    console.error('Actions: url (get download URL), download (download to server)');
    process.exit(1);
  }

  console.log(`iFinder download for document: ${documentId} (action: ${action})`);

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
      chatId: 'cli-test',
      includeMetadata: true
    });
    
    console.log('\niFinder Download Result:');
    console.log('=======================');
    console.log(`Document ID: ${result.documentId}`);
    console.log(`Action: ${result.action}`);
    
    if (result.action === 'url') {
      console.log(`Download URL: ${result.downloadUrl}`);
      console.log(`Authorization Required: ${result.authRequired}`);
      console.log(`Expires In: ${result.expiresIn}`);
    } else {
      console.log(`Status: ${result.success ? 'Success' : 'Failed'}`);
      console.log(`Filename: ${result.filename}`);
      console.log(`Size: ${result.sizeFormatted}`);
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