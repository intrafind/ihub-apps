import searchWithExtraction from './lib/searchWithExtraction.js';
import { STAAN_PAGE_SIZE, STAAN_MAX_WEB_RESULTS } from '../services/search/staanProvider.js';
import logger from '../utils/logger.js';

/**
 * Perform a web search using Staan (staan.ai), with optional content extraction.
 *
 * Shares its contract with `braveSearch` and `qwantSearch`, so an app can swap
 * `websearch.provider` without the model seeing a different tool. What Staan
 * adds over the other two is domain scoping: `includeDomains` restricts the
 * search to a set of sites, `excludeDomains` drops them.
 *
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {boolean} [params.extractContent=false] - Whether to extract full content from result pages
 * @param {number} [params.maxResults=10] - Maximum results to return / pages to extract (Staan pages in tens; more than ten costs one request per further page)
 * @param {number} [params.contentMaxLength=3000] - Maximum characters of extracted content per page
 * @param {string} [params.language] - Language/locale for the results (e.g. "de", "en-GB")
 * @param {string[]|string} [params.includeDomains] - Restrict results to these domains (max 10)
 * @param {string[]|string} [params.excludeDomains] - Drop results from these domains (max 10)
 * @param {string} [params.chatId] - The chat ID for context tracking
 * @returns {Promise<Object>} Search results, optionally with extracted page content
 * @throws {Error} If no query is provided
 */
export default async function staanSearch({
  query,
  q,
  extractContent = false,
  maxResults = STAAN_PAGE_SIZE,
  contentMaxLength = 3000,
  language,
  includeDomains,
  excludeDomains,
  chatId
}) {
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  // Staan serves at most four pages of ten. Asking for more would silently
  // return the maximum anyway, so the cap is applied up front and the model is
  // told the real number in the tool description.
  const limit = Math.min(Number(maxResults) || STAAN_PAGE_SIZE, STAAN_MAX_WEB_RESULTS);

  return searchWithExtraction({
    query: searchQuery,
    provider: 'staan',
    component: 'StaanSearch',
    extractContent,
    maxResults: limit,
    contentMaxLength,
    chatId,
    searchOptions: { language, count: limit, includeDomains, excludeDomains }
  });
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const searchQuery = args.filter(a => !a.startsWith('--')).join(' ');

  if (!searchQuery) {
    logger.error(
      'Usage: node staanSearch.js <search term> [--extract] [--max-results=N] [--language=de] [--include=a.com,b.com]'
    );
    process.exit(1);
  }

  const extractContent = args.includes('--extract');
  const maxResultsMatch = args.find(a => a.startsWith('--max-results='));
  const maxResults = maxResultsMatch
    ? parseInt(maxResultsMatch.split('=')[1]) || STAAN_PAGE_SIZE
    : STAAN_PAGE_SIZE;
  const languageMatch = args.find(a => a.startsWith('--language='));
  const language = languageMatch ? languageMatch.split('=')[1] : undefined;
  const includeMatch = args.find(a => a.startsWith('--include='));
  const includeDomains = includeMatch ? includeMatch.split('=')[1].split(',') : undefined;

  logger.info('Searching', { component: 'StaanSearch', searchQuery, extractContent });

  try {
    const result = await staanSearch({
      query: searchQuery,
      extractContent,
      maxResults,
      language,
      includeDomains
    });
    logger.info('Search complete', {
      component: 'StaanSearch',
      resultCount: result.results?.length
    });
  } catch (error) {
    logger.error('Error performing search', { component: 'StaanSearch', error });
    process.exit(1);
  }
}
