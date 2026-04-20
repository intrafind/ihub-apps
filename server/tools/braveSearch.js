import webSearchService from '../services/WebSearchService.js';
import webContentExtractor from './webContentExtractor.js';
import logger from '../utils/logger.js';

/**
 * Perform a web search using the Brave Search API, with optional content extraction.
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {boolean} [params.extractContent=false] - Whether to extract full content from result pages
 * @param {number} [params.maxResults=10] - Maximum number of results to return / pages to extract
 * @param {number} [params.contentMaxLength=3000] - Maximum characters of extracted content per page
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
  chatId
}) {
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  const rawResults = await webSearchService.search(searchQuery, {
    provider: 'brave',
    chatId
  });

  // Truncate to maxResults to honour the configured limit
  const results = rawResults.results ? rawResults.results.slice(0, maxResults) : [];

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
    component: 'BraveSearch',
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
        component: 'BraveSearch',
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
