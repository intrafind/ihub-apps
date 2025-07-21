import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';
import configCache from '../configCache.js';

/**
 * iFinder Content Fetch Tool
 * Fetch document content from iFinder for processing by LLM
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
    timeout: iFinderConfig.timeout || config.IFINDER_TIMEOUT || 60000 // Longer timeout for content fetch
  };
}

/**
 * Fetch document content for LLM processing
 * @param {Object} params - Content fetch parameters
 * @param {string} params.documentId - Document ID to fetch content for
 * @param {string} params.chatId - Chat session ID for tracking
 * @param {Object} params.user - Authenticated user object (injected by middleware)
 * @param {string} params.searchProfile - Search profile ID (optional, uses default if not specified)
 * @param {number} params.maxLength - Maximum content length in characters (default: 50000)
 * @returns {Object} Document content and metadata
 */
export default async function iFinderContent({ 
  documentId, 
  chatId, 
  user, 
  searchProfile,
  maxLength = 50000
}) {
  if (!documentId) {
    throw new Error('Document ID parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder content access requires authenticated user');
  }

  const finderConfig = getIFinderConfig();
  const profileId = searchProfile || finderConfig.defaultSearchProfile;
  
  // Track the action
  actionTracker.trackAction(chatId, { 
    action: 'ifinder_content', 
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

    console.log(`iFinder Content: Fetching content for document ${documentId} from profile "${profileId}" as user ${user.email || user.id}`);
    
    // Make API request
    const response = await throttledFetch(
      'iFinderContent',
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
        throw new Error(`Access denied to document content: ${documentId}`);
      }
      if (response.status === 413) {
        throw new Error(`Document content too large. Try reducing maxLength or specify pageRange.`);
      }
      
      throw new Error(`iFinder content fetch failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // Process and normalize the content response from RetrievalResult format
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
      contentLengthFormatted: formatContentLength(content.length),
      
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
      
      // Raw document data for advanced use
      rawDocument: doc,
      rawApiMetadata: apiMetadata
    };

    // Validate content length
    if (result.content.length === 0) {
      console.warn(`iFinder Content: No content extracted for document ${documentId}`);
    } else if (result.content.length > maxLength) {
      console.warn(`iFinder Content: Content truncated to ${maxLength} characters`);
      result.content = result.content.substring(0, maxLength) + '... [Content truncated]';
      result.truncated = true;
    }

    console.log(`iFinder Content: Successfully fetched ${result.contentLength} characters for document ${documentId}`);
    return result;

  } catch (error) {
    console.error('iFinder content fetch error:', error);
    
    if (error.message.includes('JWT') || error.message.includes('authentication')) {
      throw new Error('iFinder authentication failed. Please check JWT configuration.');
    }
    
    if (error.message.includes('timeout')) {
      throw new Error('iFinder content request timed out. Document may be too large or server is slow.');
    }
    
    throw new Error(`iFinder content fetch failed: ${error.message}`);
  }
}

/**
 * Format content length in human readable format
 * @param {number} length - Content length in characters
 * @returns {string} Formatted content length
 */
function formatContentLength(length) {
  if (length < 1000) {
    return `${length} characters`;
  } else if (length < 1000000) {
    return `${Math.round(length / 1000 * 10) / 10}K characters`;
  } else {
    return `${Math.round(length / 1000000 * 10) / 10}M characters`;
  }
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const documentId = process.argv[2];
  const format = process.argv[3] || 'text';

  if (!documentId) {
    console.error('Usage: node iFinderContent.js <document-id> [format]');
    console.error('Example: node iFinderContent.js "doc123456" "text"');
    console.error('Formats: text, html, markdown, raw');
    process.exit(1);
  }

  console.log(`Fetching iFinder content for document: ${documentId} (format: ${format})`);

  try {
    // Mock user for CLI testing
    const mockUser = {
      id: 'test-user',
      email: 'test@example.com',
      name: 'Test User',
      isAdmin: false,
      groups: ['users']
    };

    const result = await iFinderContent({ 
      documentId: documentId, 
      user: mockUser,
      chatId: 'cli-test',
      maxLength: 10000 // Smaller limit for CLI output
    });
    
    console.log('\niFinder Document Content:');
    console.log('========================');
    console.log(`Document ID: ${result.documentId}`);
    console.log(`Content Length: ${result.contentLengthFormatted}`);
    
    if (result.metadata) {
      console.log(`Title: ${result.metadata.title}`);
      console.log(`Type: ${result.metadata.documentType}`);
      console.log(`Author: ${result.metadata.author}`);
    }
    
    if (result.took) {
      console.log(`Fetch Time: ${result.took}`);
    }
    
    console.log('\nContent Preview (first 500 characters):');
    console.log('======================================');
    console.log(result.content.substring(0, 500));
    
    if (result.content.length > 500) {
      console.log('... [Content continues]');
    }
    
    if (result.truncated) {
      console.log('\n⚠️  Content was truncated due to length limit');
    }
    
  } catch (error) {
    console.error('Error fetching iFinder content:', error.message);
    process.exit(1);
  }
}