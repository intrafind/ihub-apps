import webSearchService from '../services/WebSearchService.js';
import webContentExtractor from './webContentExtractor.js';
import logger from '../utils/logger.js';

/**
 * Perform a web search using the Tavily Search API, with optional content extraction.
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {string} [params.search_depth='basic'] - Search depth ('basic' or 'advanced')
 * @param {number} [params.max_results=5] - Maximum number of results to return
 * @param {boolean} [params.extractContent=false] - Whether to extract full content from result pages
 * @param {number} [params.contentMaxLength=3000] - Maximum characters of extracted content per page
 * @param {string} [params.chatId] - The chat ID for context tracking
 * @returns {Promise<Object>} Search results, optionally with extracted page content
 * @throws {Error} If no query is provided
 */
export default async function tavilySearch({
  query,
  q,
  search_depth = 'basic',
  max_results = 5,
  extractContent = false,
  contentMaxLength = 3000,
  chatId
}) {
  const searchQuery = query || q;
  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  const rawResults = await webSearchService.search(searchQuery, {
    provider: 'tavily',
    chatId,
    search_depth,
    max_results
  });

  // Tavily already limits to max_results server-side, but truncate defensively
  const results = rawResults.results ? rawResults.results.slice(0, max_results) : [];

  if (!extractContent) {
    return { ...rawResults, results };
  }

  // Content extraction: fetch page content for the top N results
  if (results.length === 0) {
    return {
      query: searchQuery,
      results: [],
      extractedContent: [],
      summary: 'No search results found.'
    };
  }

  const resultsToProcess = results;

  logger.info('Extracting content from search results', {
    component: 'TavilySearch',
    count: resultsToProcess.length
  });

  const contentPromises = resultsToProcess.map(async result => {
    try {
      const content = await webContentExtractor({
        url: result.url,
        maxLength: contentMaxLength,
        chatId
      });
      return {
        ...result,
        extractedContent: content,
        contentExtracted: true,
        extractionError: null
      };
    } catch (error) {
      logger.warn('Failed to extract content from URL', {
        component: 'TavilySearch',
        url: result.url,
        error
      });
      return {
        ...result,
        extractedContent: null,
        contentExtracted: false,
        extractionError: error.message
      };
    }
  });

  const settled = await Promise.allSettled(contentPromises);
  const extractedContent = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          ...resultsToProcess[i],
          extractedContent: null,
          contentExtracted: false,
          extractionError: r.reason?.message || 'Unknown error'
        }
  );

  const successCount = extractedContent.filter(r => r.contentExtracted).length;

  return {
    query: searchQuery,
    results,
    extractedContent,
    summary: `Found ${results.length} results for "${searchQuery}". Extracted content from ${successCount} of ${resultsToProcess.length} pages.`,
    stats: {
      totalSearchResults: results.length,
      processedResults: resultsToProcess.length,
      successfulExtractions: successCount,
      failedExtractions: extractedContent.length - successCount
    }
  };
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const searchQuery = args.filter(a => !a.startsWith('--')).join(' ');

  if (!searchQuery) {
    logger.error('Usage: node tavilySearch.js <search term> [--extract] [--max-results=N]');
    process.exit(1);
  }

  const extractContent = args.includes('--extract');
  const maxResultsMatch = args.find(a => a.startsWith('--max-results='));
  const max_results = maxResultsMatch ? parseInt(maxResultsMatch.split('=')[1]) || 5 : 5;

  logger.info('Searching', { component: 'TavilySearch', searchQuery, extractContent });

  try {
    const result = await tavilySearch({ query: searchQuery, extractContent, max_results });
    logger.info('Search complete', {
      component: 'TavilySearch',
      resultCount: result.results?.length
    });
  } catch (error) {
    logger.error('Error performing search', { component: 'TavilySearch', error });
    process.exit(1);
  }
}
