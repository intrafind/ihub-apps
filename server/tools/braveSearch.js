import searchWithExtraction from './lib/searchWithExtraction.js';
import logger from '../utils/logger.js';

/**
 * Perform a web search using the Brave Search API, with optional content extraction.
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {boolean} [params.extractContent=false] - Whether to extract full content from result pages
 * @param {number} [params.maxResults=10] - Maximum number of results to return / pages to extract
 * @param {number} [params.contentMaxLength=3000] - Maximum characters of extracted content per page
 * @param {string} [params.language] - Language/locale for the results (e.g. "de", "en-GB")
 * @param {string} [params.chatId] - The chat ID for context tracking
 * @returns {Promise<Object>} Search results, optionally with extracted page content
 * @throws {Error} If no query is provided
 */
export default async function braveSearch({
  query,
  q,
  extractContent = false,
  maxResults = 10,
  contentMaxLength = 3000,
  language,
  chatId
}) {
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  return searchWithExtraction({
    query: searchQuery,
    provider: 'brave',
    component: 'BraveSearch',
    extractContent,
    maxResults,
    contentMaxLength,
    chatId,
    searchOptions: { language }
  });
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const searchQuery = args.filter(a => !a.startsWith('--')).join(' ');

  if (!searchQuery) {
    logger.error('Usage: node braveSearch.js <search term> [--extract] [--max-results=N]');
    process.exit(1);
  }

  const extractContent = args.includes('--extract');
  const maxResultsMatch = args.find(a => a.startsWith('--max-results='));
  const maxResults = maxResultsMatch ? parseInt(maxResultsMatch.split('=')[1]) || 10 : 10;

  logger.info('Searching', { component: 'BraveSearch', searchQuery, extractContent });

  try {
    const result = await braveSearch({ query: searchQuery, extractContent, maxResults });
    logger.info('Search complete', {
      component: 'BraveSearch',
      resultCount: result.results?.length
    });
  } catch (error) {
    logger.error('Error performing search', { component: 'BraveSearch', error });
    process.exit(1);
  }
}
