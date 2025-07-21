import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';

/**
 * iFinder Content Fetch Tool
 * Fetch document content from iFinder for processing by LLM
 */

/**
 * Get iFinder API configuration
 * @returns {Object} iFinder API configuration
 */
function getIFinderConfig() {
  return {
    baseUrl: config.IFINDER_API_URL || process.env.IFINDER_API_URL || 'https://api.ifinder.example.com',
    contentEndpoint: config.IFINDER_CONTENT_ENDPOINT || process.env.IFINDER_CONTENT_ENDPOINT || '/api/v1/documents/{documentId}/content',
    timeout: config.IFINDER_TIMEOUT || 60000 // Longer timeout for content fetch
  };
}

/**
 * Fetch document content for LLM processing
 * @param {Object} params - Content fetch parameters
 * @param {string} params.documentId - Document ID to fetch content for
 * @param {string} params.chatId - Chat session ID for tracking
 * @param {Object} params.user - Authenticated user object (injected by middleware)
 * @param {string} params.format - Content format ('text', 'html', 'markdown', 'raw') - default: 'text'
 * @param {number} params.maxLength - Maximum content length in characters (default: 50000)
 * @param {boolean} params.includeMetadata - Include document metadata with content (default: true)
 * @param {string} params.pageRange - Specific page range for multi-page documents (e.g., '1-5')
 * @returns {Object} Document content and metadata
 */
export default async function iFinderContent({ 
  documentId, 
  chatId, 
  user, 
  format = 'text', 
  maxLength = 50000,
  includeMetadata = true,
  pageRange
}) {
  if (!documentId) {
    throw new Error('Document ID parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder content access requires authenticated user');
  }

  const finderConfig = getIFinderConfig();
  
  // Track the action
  actionTracker.trackAction(chatId, { 
    action: 'ifinder_content', 
    documentId: documentId,
    format: format,
    user: user.id
  });

  try {
    // Generate JWT token for the user
    const authHeader = getIFinderAuthorizationHeader(user, { scope: 'fa_index_read' });
    
    // Construct content URL
    const contentUrl = `${finderConfig.baseUrl}${finderConfig.contentEndpoint.replace('{documentId}', encodeURIComponent(documentId))}`;
    
    // Add query parameters
    const urlParams = new URLSearchParams();
    urlParams.append('format', format);
    
    if (maxLength && maxLength > 0) {
      urlParams.append('maxLength', maxLength.toString());
    }
    
    if (includeMetadata) {
      urlParams.append('includeMetadata', 'true');
    }
    
    if (pageRange) {
      urlParams.append('pageRange', pageRange);
    }
    
    const finalUrl = `${contentUrl}?${urlParams.toString()}`;

    console.log(`iFinder Content: Fetching content for document ${documentId} as user ${user.email || user.id}`);
    
    // Make API request
    const response = await throttledFetch(
      'iFinderContent',
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
        throw new Error(`Access denied to document content: ${documentId}`);
      }
      if (response.status === 413) {
        throw new Error(`Document content too large. Try reducing maxLength or specify pageRange.`);
      }
      
      throw new Error(`iFinder content fetch failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // Process and normalize the content response
    const result = {
      documentId: data.documentId || documentId,
      content: data.content || data.text || '',
      format: data.format || format,
      
      // Content metadata
      contentLength: (data.content || data.text || '').length,
      contentLengthFormatted: formatContentLength((data.content || data.text || '').length),
      extractedPages: data.extractedPages || data.pageCount,
      pageRange: data.pageRange || pageRange,
      
      // Processing information
      extractionMethod: data.extractionMethod || 'unknown',
      lastExtracted: data.lastExtracted || data.extractedAt,
      quality: data.quality || 'unknown',
      
      // Document metadata (if included)
      ...(includeMetadata && data.metadata && {
        metadata: {
          title: data.metadata.title,
          documentType: data.metadata.documentType || data.metadata.type,
          language: data.metadata.language,
          author: data.metadata.author,
          createdDate: data.metadata.createdDate,
          lastModified: data.metadata.lastModified,
          fileSize: data.metadata.size,
          filename: data.metadata.filename
        }
      }),
      
      // Content structure (for structured documents)
      ...(data.structure && {
        structure: {
          headings: data.structure.headings || [],
          sections: data.structure.sections || [],
          tables: data.structure.tables || [],
          images: data.structure.images || []
        }
      })
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
      format: format,
      chatId: 'cli-test',
      maxLength: 10000, // Smaller limit for CLI output
      includeMetadata: true
    });
    
    console.log('\niFinder Document Content:');
    console.log('========================');
    console.log(`Document ID: ${result.documentId}`);
    console.log(`Content Length: ${result.contentLengthFormatted}`);
    console.log(`Format: ${result.format}`);
    
    if (result.metadata) {
      console.log(`Title: ${result.metadata.title}`);
      console.log(`Type: ${result.metadata.documentType}`);
      console.log(`Author: ${result.metadata.author}`);
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