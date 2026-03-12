import webSearchService from '../services/WebSearchService.js';
import logger from '../utils/logger.js';

/**
 * Perform a web search using the Tavily Search API
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {string} [params.search_depth='basic'] - Search depth ('basic' or 'advanced')
 * @param {number} [params.max_results=5] - Maximum number of results to return
 * @param {string} [params.chatId] - The chat ID for context tracking
 * @returns {Promise<{results: Array<{title: string, url: string, description: string}>}>} The search results
 * @throws {Error} If no query is provided
 */
export default async function tavilySearch({
  query,
  q,
  search_depth = 'basic',
  max_results = 5,
  chatId
}) {
  const searchQuery = query || q;
  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  // Use the unified web search service with tavily provider
  return await webSearchService.search(searchQuery, {
    provider: 'tavily',
    chatId,
    search_depth,
    max_results
  });
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const searchQuery = process.argv.slice(2).join(' ');

  if (!searchQuery) {
    logger.error('Usage: node tavilySearch.js <search term>');
    logger.error('Example: node tavilySearch.js "JavaScript tutorials"');
    process.exit(1);
  }

  logger.info('Searching', { component: 'TavilySearch', searchQuery });

  try {
    const result = await tavilySearch({ query: searchQuery });

    if (result.results.length === 0) {
      logger.info('No results found', { component: 'TavilySearch' });
    } else {
      result.results.forEach((item, index) => {
        logger.info('Search result', {
          component: 'TavilySearch',
          index: index + 1,
          title: item.title,
          url: item.url
        });
      });
    }
  } catch (error) {
    logger.error('Error performing search', { component: 'TavilySearch', error });
    process.exit(1);
  }
}
