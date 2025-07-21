import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';

/**
 * iFinder Search Tool
 * Search for documents in iFinder using the search API
 */

/**
 * Get iFinder API configuration
 * @returns {Object} iFinder API configuration
 */
function getIFinderConfig() {
  return {
    baseUrl: config.IFINDER_API_URL || process.env.IFINDER_API_URL || 'https://api.ifinder.example.com',
    searchEndpoint: config.IFINDER_SEARCH_ENDPOINT || process.env.IFINDER_SEARCH_ENDPOINT || '/api/v1/search',
    timeout: config.IFINDER_TIMEOUT || 30000
  };
}

/**
 * Search for documents in iFinder
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query string
 * @param {string} params.chatId - Chat session ID for tracking
 * @param {Object} params.user - Authenticated user object (injected by middleware)
 * @param {number} params.maxResults - Maximum number of results to return (default: 10)
 * @param {string} params.language - Language filter (optional)
 * @param {string} params.documentType - Document type filter (optional)
 * @returns {Object} Search results
 */
export default async function iFinderSearch({ query, chatId, user, maxResults = 10, language, documentType }) {
  if (!query) {
    throw new Error('Query parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder search requires authenticated user');
  }

  const finderConfig = getIFinderConfig();
  
  // Track the action
  actionTracker.trackAction(chatId, { 
    action: 'ifinder_search', 
    query: query,
    user: user.id
  });

  try {
    // Generate JWT token for the user
    const authHeader = getIFinderAuthorizationHeader(user, { scope: 'fa_index_read' });
    
    // Construct search URL
    const searchUrl = `${finderConfig.baseUrl}${finderConfig.searchEndpoint}`;
    
    // Prepare request body
    const requestBody = {
      query: query,
      maxResults: Math.min(maxResults, 50), // Limit to reasonable number
      ...(language && { language }),
      ...(documentType && { documentType })
    };

    console.log(`iFinder Search: Searching for "${query}" as user ${user.email || user.id}`);
    
    // Make API request
    const response = await throttledFetch(
      'iFinderSearch',
      searchUrl,
      {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody),
        timeout: finderConfig.timeout
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`iFinder search failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // Process and normalize the results
    const results = {
      query: query,
      totalFound: data.totalFound || data.total || (data.results ? data.results.length : 0),
      results: []
    };

    // Normalize result format (adapt based on actual API response)
    if (data.results && Array.isArray(data.results)) {
      results.results = data.results.map(item => ({
        id: item.id || item.documentId,
        title: item.title || item.name,
        summary: item.summary || item.description || item.snippet,
        url: item.url,
        documentType: item.documentType || item.type,
        language: item.language,
        lastModified: item.lastModified || item.modifiedDate,
        size: item.size,
        author: item.author,
        metadata: item.metadata || {}
      }));
    }

    console.log(`iFinder Search: Found ${results.totalFound} results`);
    return results;

  } catch (error) {
    console.error('iFinder search error:', error);
    
    if (error.message.includes('JWT') || error.message.includes('authentication')) {
      throw new Error('iFinder authentication failed. Please check JWT configuration.');
    }
    
    if (error.message.includes('timeout')) {
      throw new Error('iFinder search request timed out. Please try again.');
    }
    
    throw new Error(`iFinder search failed: ${error.message}`);
  }
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const searchQuery = process.argv.slice(2).join(' ');

  if (!searchQuery) {
    console.error('Usage: node iFinderSearch.js <search query>');
    console.error('Example: node iFinderSearch.js "artificial intelligence"');
    process.exit(1);
  }

  console.log(`Searching iFinder for: "${searchQuery}"`);

  try {
    // Mock user for CLI testing
    const mockUser = {
      id: 'test-user',
      email: 'test@example.com',
      name: 'Test User',
      isAdmin: false,
      groups: ['users']
    };

    const result = await iFinderSearch({ 
      query: searchQuery, 
      user: mockUser,
      chatId: 'cli-test'
    });
    
    console.log('\niFinder Search Results:');
    console.log('======================');
    console.log(`Total found: ${result.totalFound}`);
    
    if (result.results.length === 0) {
      console.log('No results found.');
    } else {
      result.results.forEach((item, index) => {
        console.log(`${index + 1}. ${item.title}`);
        console.log(`   ID: ${item.id}`);
        console.log(`   Type: ${item.documentType || 'Unknown'}`);
        console.log(`   Summary: ${item.summary || 'No summary available'}`);
        if (item.url) {
          console.log(`   URL: ${item.url}`);
        }
        console.log('');
      });
    }
  } catch (error) {
    console.error('Error performing iFinder search:', error.message);
    process.exit(1);
  }
}