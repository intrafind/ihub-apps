import webSearchService from '../services/WebSearchService.js';
import logger from '../utils/logger.js';

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

  logger.info(`Searching for: "${searchQuery}"`);

  try {
    const result = await braveSearch({ query: searchQuery });
    logger.info('\nSearch Results:');
    logger.info('===============');

    if (result.results.length === 0) {
      logger.info('No results found.');
    } else {
      result.results.forEach((item, index) => {
        logger.info(`${index + 1}. ${item.title}`);
        logger.info(`   URL: ${item.url}\n`);
        logger.info(`   Result: ${JSON.stringify(item, null, 2)}\n`);
      });
    }
  } catch (error) {
    logger.error('Error performing search:', error.message);
    process.exit(1);
  }
}
