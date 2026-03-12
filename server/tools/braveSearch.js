import webSearchService from '../services/WebSearchService.js';
import logger from '../utils/logger.js';

/**
 * Perform a web search using the Brave Search API
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {string} [params.chatId] - The chat ID for context tracking
 * @returns {Promise<{results: Array<{title: string, url: string, description: string}>}>} The search results
 * @throws {Error} If no query is provided
 */
export default async function braveSearch({ query, q, chatId }) {
  // Accept both 'query' and 'q' parameters for flexibility
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  // Use the unified web search service with brave provider
  return await webSearchService.search(searchQuery, {
    provider: 'brave',
    chatId
  });
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const searchQuery = process.argv.slice(2).join(' ');

  if (!searchQuery) {
    logger.error('Usage: node braveSearch.js <search term>');
    logger.error('Example: node braveSearch.js "JavaScript tutorials"');
    process.exit(1);
  }

  logger.info('Searching', { component: 'BraveSearch', searchQuery });

  try {
    const result = await braveSearch({ query: searchQuery });

    if (result.results.length === 0) {
      logger.info('No results found', { component: 'BraveSearch' });
    } else {
      result.results.forEach((item, index) => {
        logger.info('Search result', {
          component: 'BraveSearch',
          index: index + 1,
          title: item.title,
          url: item.url
        });
      });
    }
  } catch (error) {
    logger.error('Error performing search', { component: 'BraveSearch', error });
    process.exit(1);
  }
}
