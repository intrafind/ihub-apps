import webSearchService from '../../services/WebSearchService.js';
import webContentExtractor from '../webContentExtractor.js';
import logger from '../../utils/logger.js';

/**
 * Shared body of the script-backed web search tools (`braveSearch`,
 * `qwantSearch`): run a query through {@link webSearchService} and, when asked,
 * fetch and trim the pages behind the top results.
 *
 * The tools differ only in which provider they name and how they log, so the
 * result shape — and the summary the model reads — stays identical across
 * providers. That is what lets an app swap `websearch.provider` without the
 * model seeing a different contract.
 *
 * @module tools/lib/searchWithExtraction
 */

/**
 * @param {Object} params
 * @param {string} params.query - Search terms (already resolved from `query`/`q`)
 * @param {string} params.provider - Provider id registered with the search service
 * @param {string} params.component - Component name used in log lines
 * @param {boolean} [params.extractContent=false] - Fetch page content for the results
 * @param {number} [params.maxResults=10] - Cap on results returned / pages extracted
 * @param {number} [params.contentMaxLength=3000] - Characters of content kept per page
 * @param {string} [params.chatId] - Chat id, for progress events
 * @param {Object} [params.searchOptions] - Extra provider options (e.g. `language`)
 * @returns {Promise<Object>} Search results, optionally with extracted page content
 */
export default async function searchWithExtraction({
  query,
  provider,
  component,
  extractContent = false,
  maxResults = 10,
  contentMaxLength = 3000,
  chatId,
  searchOptions = {}
}) {
  const rawResults = await webSearchService.search(query, {
    ...searchOptions,
    provider,
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
      query,
      results: [],
      extractedContent: [],
      summary: 'No search results found.'
    };
  }

  const resultsToProcess = results;

  logger.info('Extracting content from search results', {
    component,
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
        component,
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
    query,
    results,
    extractedContent,
    summary: `Found ${results.length} results for "${query}". Extracted content from ${successCount} of ${resultsToProcess.length} pages.`,
    stats: {
      totalSearchResults: results.length,
      processedResults: resultsToProcess.length,
      successfulExtractions: successCount,
      failedExtractions: extractedContent.length - successCount
    }
  };
}
