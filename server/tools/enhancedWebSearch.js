import braveSearch from './braveSearch.js';
import webContentExtractor from './webContentExtractor.js';
import logger from '../utils/logger.js';

/**
 * Enhanced web search that combines Brave search with content extraction.
 * Performs a web search and optionally extracts full content from the top results.
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {boolean} [params.extractContent=true] - Whether to extract content from results
 * @param {number} [params.maxResults=3] - Maximum number of results to process for extraction
 * @param {number} [params.contentMaxLength=3000] - Maximum length of extracted content per result
 * @returns {Promise<{query: string, searchResults: Array, extractedContent: Array, summary: string, stats: Object}>} Search results with optional extracted content
 * @throws {Error} If no query is provided or search fails
 */
export default async function enhancedWebSearch({
  query,
  q,
  extractContent = true,
  maxResults = 3,
  contentMaxLength = 3000
}) {
  logger.info(`Starting enhanced web search for: "${query || q}"`);
  // Accept both 'query' and 'q' parameters for flexibility
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  try {
    // First, perform the brave search
    logger.info(`Searching for: "${searchQuery}"`);
    const searchResults = await braveSearch({ query: searchQuery });

    if (!searchResults.results || searchResults.results.length === 0) {
      return {
        query: searchQuery,
        searchResults: [],
        extractedContent: [],
        summary: 'No search results found.'
      };
    }

    // Limit the number of results to process
    const resultsToProcess = searchResults.results.slice(0, maxResults);
    const extractedContent = [];

    if (extractContent) {
      logger.info(`Extracting content from top ${resultsToProcess.length} results...`);

      // Extract content from each URL in parallel
      const contentPromises = resultsToProcess.map(async result => {
        try {
          logger.info(`Extracting content from: ${result.url}`);
          const content = await webContentExtractor({
            url: result.url,
            maxLength: contentMaxLength
          });

          return {
            ...result,
            extractedContent: content,
            contentExtracted: true,
            extractionError: null
          };
        } catch (error) {
          logger.warn(`Failed to extract content from ${result.url}: ${error.message}`);
          return {
            ...result,
            extractedContent: null,
            contentExtracted: false,
            extractionError: error.message
          };
        }
      });

      // Wait for all content extractions to complete
      const contentResults = await Promise.allSettled(contentPromises);

      contentResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          extractedContent.push(result.value);
        } else {
          // If extraction completely failed, still include the search result
          extractedContent.push({
            ...resultsToProcess[index],
            extractedContent: null,
            contentExtracted: false,
            extractionError: result.reason?.message || 'Unknown extraction error'
          });
        }
      });
    } else {
      // If not extracting content, just return the search results
      extractedContent.push(
        ...resultsToProcess.map(result => ({
          ...result,
          contentExtracted: false,
          extractionError: null
        }))
      );
    }

    // Generate a summary
    const successfulExtractions = extractedContent.filter(item => item.contentExtracted);
    const summary = `Found ${searchResults.results.length} search results for "${searchQuery}". ${
      extractContent
        ? `Successfully extracted content from ${successfulExtractions.length} of ${resultsToProcess.length} top results.`
        : 'Content extraction was disabled.'
    }`;

    // Generate a clean, text-based summary for the LLM
    // let llmOutput = `${summary}\n\n`;
    // extractedContent.forEach(item => {
    //   llmOutput += `Source: ${item.title}\n`;
    //   llmOutput += `URL: ${item.url}\n`;
    //   if (item.contentExtracted && item.extractedContent?.content) {
    //     llmOutput += `Content:\n${item.extractedContent.content}\n\n`;
    //   } else {
    //     llmOutput += `Content could not be extracted. Snippet: ${item.description}\n\n`;
    //   }
    // });

    // return llmOutput;
    return {
      query: searchQuery,
      searchResults: searchResults.results,
      extractedContent: extractedContent,
      summary: summary,
      stats: {
        totalSearchResults: searchResults.results.length,
        processedResults: resultsToProcess.length,
        successfulExtractions: successfulExtractions.length,
        failedExtractions: extractedContent.length - successfulExtractions.length
      }
    };
  } catch (error) {
    throw new Error(`Enhanced web search failed: ${error.message}`);
  }
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const query = args.join(' ');

  if (!query) {
    logger.error('Usage: node enhancedWebSearch.js <search term> [--no-extract] [--max-results=N]');
    logger.error('Example: node enhancedWebSearch.js "JavaScript tutorials"');
    logger.error('Example: node enhancedWebSearch.js "AI news" --no-extract --max-results=5');
    process.exit(1);
  }

  // Parse CLI options
  const extractContent = !args.includes('--no-extract');
  const maxResultsMatch = args.find(arg => arg.startsWith('--max-results='));
  const maxResults = maxResultsMatch ? parseInt(maxResultsMatch.split('=')[1]) || 3 : 3;

  // Remove options from query
  const cleanQuery = args.filter(arg => !arg.startsWith('--')).join(' ');

  logger.info(`Enhanced search for: "${cleanQuery}"`);
  logger.info(`Extract content: ${extractContent}, Max results: ${maxResults}`);

  try {
    const result = await enhancedWebSearch({
      query: cleanQuery,
      extractContent,
      maxResults
    });

    logger.info('\n' + '='.repeat(50));
    logger.info('ENHANCED WEB SEARCH RESULTS');
    logger.info('='.repeat(50));
    logger.info(`Summary: ${result.summary}`);
    logger.info(`Stats: ${JSON.stringify(result.stats, null, 2)}`);

    result.extractedContent.forEach((item, index) => {
      logger.info(`\n${index + 1}. ${item.title}`);
      logger.info(`   URL: ${item.url}`);
      logger.info(`   Description: ${item.description}`);

      if (item.contentExtracted && item.extractedContent) {
        logger.info(`   Content extracted: Yes (${item.extractedContent.wordCount} words)`);
        logger.info(`   Content preview: ${item.extractedContent.content.substring(0, 200)}...`);
      } else {
        logger.info('   Content extracted: No');
        if (item.extractionError) {
          logger.info(`   Extraction error: ${item.extractionError}`);
        }
      }
    });
  } catch (error) {
    logger.error('Error performing enhanced search:', error.message);
    process.exit(1);
  }
}
