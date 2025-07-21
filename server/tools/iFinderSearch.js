import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';
import configCache from '../configCache.js';

/**
 * iFinder Search Tool
 * Search for documents in iFinder using the search API
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
    searchEndpoint: iFinderConfig.endpoints?.search || '/public-api/retrieval/api/v1/search-profiles/{profileId}/_search',
    defaultSearchProfile: iFinderConfig.defaultSearchProfile || process.env.IFINDER_SEARCH_PROFILE || 'default',
    timeout: iFinderConfig.timeout || config.IFINDER_TIMEOUT || 30000
  };
}

/**
 * Search for documents in iFinder
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query string (Lucene syntax)
 * @param {string} params.chatId - Chat session ID for tracking
 * @param {Object} params.user - Authenticated user object (injected by middleware)
 * @param {number} params.maxResults - Maximum number of results to return (default: 10)
 * @param {string} params.searchProfile - Search profile ID (optional, uses default if not specified)
 * @param {Array} params.returnFields - Fields to return in search results (optional)
 * @param {Array} params.returnFacets - Facets to return in search results (optional)
 * @param {Array} params.sort - Sorting criteria in format 'field:asc/desc' (optional)
 * @returns {Object} Search results
 */
export default async function iFinderSearch({ 
  query, 
  chatId, 
  user, 
  maxResults = 10, 
  searchProfile,
  returnFields,
  returnFacets,
  sort
}) {
  if (!query) {
    throw new Error('Query parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder search requires authenticated user');
  }

  const finderConfig = getIFinderConfig();
  const profileId = searchProfile || finderConfig.defaultSearchProfile;
  
  // Track the action
  actionTracker.trackAction(chatId, { 
    action: 'ifinder_search', 
    query: query,
    searchProfile: profileId,
    user: user.id
  });

  try {
    // Generate JWT token for the user
    const authHeader = getIFinderAuthorizationHeader(user, { scope: 'fa_index_read' });
    
    // Construct search URL with profile ID
    const searchEndpoint = finderConfig.searchEndpoint.replace('{profileId}', encodeURIComponent(profileId));
    const baseUrl = `${finderConfig.baseUrl}${searchEndpoint}`;
    
    // Build query parameters
    const params = new URLSearchParams();
    if (query) params.append('query', query);
    params.append('size', Math.min(maxResults, 100).toString()); // API max is likely higher than 50
    
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

    console.log(`iFinder Search: Searching for "${query}" in profile "${profileId}" as user ${user.email || user.id}`);
    
    // Make API request (using GET as per the real API)
    const response = await throttledFetch(
      'iFinderSearch',
      searchUrl,
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
      throw new Error(`iFinder search failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // Process and normalize the results based on real API response format
    const results = {
      query: query,
      searchProfile: profileId,
      metadata: data.metadata || {},
      totalFound: data.metadata?.total_hits || (data.results ? data.results.length : 0),
      took: data.metadata?.took,
      results: [],
      facets: data.facets || null
    };

    // Normalize result format based on real iFinder API response structure
    if (data.results && Array.isArray(data.results)) {
      results.results = data.results.map(hit => {
        const doc = hit.document || {};
        const metadata = hit.metadata || {};
        
        return {
          // Document identification
          id: doc.id,
          score: metadata.score,
          
          // Basic document fields (from document object)
          title: doc.title,
          content: doc.content, 
          url: doc.url,
          filename: doc.filename,
          
          // Document metadata fields
          documentType: doc.documentType || doc.type,
          mimeType: doc.mimeType,
          language: doc.language,
          size: doc.size,
          author: doc.author || doc.creator,
          createdDate: doc.createdDate || doc.created,
          lastModified: doc.lastModified || doc.modified,
          
          // Search-specific metadata
          teasers: metadata.teasers || [],
          
          // Raw document data for advanced use
          rawDocument: doc,
          rawMetadata: metadata
        };
      });
    }

    console.log(`iFinder Search: Found ${results.totalFound} results in ${results.took || 'unknown time'}`);
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