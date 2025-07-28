import webSearchService from '../services/WebSearchService.js';
import config from '../config.js';

/**
 * Unified Web Search Tool
 * Uses the WebSearchService to perform searches with different providers
 * Provider is automatically selected based on platform configuration
 */
export default async function webSearch({ query, q, provider, chatId, ...options }) {
  // Accept both 'query' and 'q' parameters for flexibility
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  // Determine provider from platform config or use specified provider
  let selectedProvider = provider;
  
  if (!selectedProvider) {
    // Auto-select provider based on available API keys
    if (config.BRAVE_SEARCH_API_KEY) {
      selectedProvider = 'brave';
    } else if (config.TAVILY_SEARCH_API_KEY) {
      selectedProvider = 'tavily';
    } else {
      throw new Error('No search provider API key is configured');
    }
  }

  // Perform the search using the web search service
  return await webSearchService.search(searchQuery, {
    provider: selectedProvider,
    chatId,
    ...options
  });
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const searchQuery = process.argv.slice(2).join(' ');

  if (!searchQuery) {
    console.error('Usage: node webSearch.js <search term>');
    console.error('Example: node webSearch.js "JavaScript tutorials"');
    process.exit(1);
  }

  console.log(`Searching for: "${searchQuery}"`);

  try {
    const result = await webSearch({ query: searchQuery });
    console.log('\nSearch Results:');
    console.log('===============');

    if (result.results.length === 0) {
      console.log('No results found.');
    } else {
      result.results.forEach((item, index) => {
        console.log(`${index + 1}. ${item.title}`);
        console.log(`   URL: ${item.url}`);
        console.log(`   Description: ${item.description}`);
        console.log('');
      });
    }
  } catch (error) {
    console.error('Error performing search:', error.message);
    process.exit(1);
  }
}