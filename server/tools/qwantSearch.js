import searchWithExtraction from './lib/searchWithExtraction.js';
import { QWANT_MAX_WEB_RESULTS } from '../services/search/qwantProvider.js';
import logger from '../utils/logger.js';

/**
 * Perform a web search using Qwant, with optional content extraction.
 *
 * Qwant is the keyless counterpart to `braveSearch`: it needs no API key and no
 * account, so an install with no search subscription can still answer from the
 * live web. The result shape is identical to `braveSearch`, so an app can swap
 * `websearch.provider` without the model seeing a different contract.
 *
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {boolean} [params.extractContent=false] - Whether to extract full content from result pages
 * @param {number} [params.maxResults=10] - Maximum results to return / pages to extract (Qwant returns at most 10 per search)
 * @param {number} [params.contentMaxLength=3000] - Maximum characters of extracted content per page
 * @param {string} [params.language] - Language/locale for the results (e.g. "de", "en-GB")
 * @param {string} [params.chatId] - The chat ID for context tracking
 * @returns {Promise<Object>} Search results, optionally with extracted page content
 * @throws {Error} If no query is provided
 */
export default async function qwantSearch({
  query,
  q,
  extractContent = false,
  maxResults = QWANT_MAX_WEB_RESULTS,
  contentMaxLength = 3000,
  language,
  chatId
}) {
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  // A single Qwant web request pages in tens. Asking the provider for more than
  // that would silently return ten anyway, so the cap is applied up front and
  // the model is told the real number in the tool description.
  const limit = Math.min(Number(maxResults) || QWANT_MAX_WEB_RESULTS, QWANT_MAX_WEB_RESULTS);

  return searchWithExtraction({
    query: searchQuery,
    provider: 'qwant',
    component: 'QwantSearch',
    extractContent,
    maxResults: limit,
    contentMaxLength,
    chatId,
    searchOptions: { language, count: limit }
  });
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const searchQuery = args.filter(a => !a.startsWith('--')).join(' ');

  if (!searchQuery) {
    logger.error(
      'Usage: node qwantSearch.js <search term> [--extract] [--max-results=N] [--language=de]'
    );
    process.exit(1);
  }

  const extractContent = args.includes('--extract');
  const maxResultsMatch = args.find(a => a.startsWith('--max-results='));
  const maxResults = maxResultsMatch
    ? parseInt(maxResultsMatch.split('=')[1]) || QWANT_MAX_WEB_RESULTS
    : QWANT_MAX_WEB_RESULTS;
  const languageMatch = args.find(a => a.startsWith('--language='));
  const language = languageMatch ? languageMatch.split('=')[1] : undefined;

  logger.info('Searching', { component: 'QwantSearch', searchQuery, extractContent });

  try {
    const result = await qwantSearch({
      query: searchQuery,
      extractContent,
      maxResults,
      language
    });
    logger.info('Search complete', {
      component: 'QwantSearch',
      resultCount: result.results?.length
    });
  } catch (error) {
    logger.error('Error performing search', { component: 'QwantSearch', error });
    process.exit(1);
  }
}
