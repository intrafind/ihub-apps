import braveSearch from './braveSearch.js';
import webContentExtractor from './webContentExtractor.js';

/**
 * Enhanced web search that combines Brave search with content extraction
 * Performs a web search and optionally extracts full content from the top results
 */
export default async function enhancedWebSearch({
  query,
  q,
  extractContent = true,
  maxResults = 3,
  contentMaxLength = 3000
}) {
  console.log(`Starting enhanced web search for: "${query || q}"`);
  // Accept both 'query' and 'q' parameters for flexibility
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  try {
    // First, perform the brave search
    console.log(`Searching for: "${searchQuery}"`);
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
      console.log(`Extracting content from top ${resultsToProcess.length} results...`);

      // Extract content from each URL in parallel
      const contentPromises = resultsToProcess.map(async (result) => {
        try {
          console.log(`Extracting content from: ${result.url}`);
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
          console.warn(`Failed to extract content from ${result.url}: ${error.message}`);
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
    console.error(
      'Usage: node enhancedWebSearch.js <search term> [--no-extract] [--max-results=N]'
    );
    console.error('Example: node enhancedWebSearch.js "JavaScript tutorials"');
    console.error('Example: node enhancedWebSearch.js "AI news" --no-extract --max-results=5');
    process.exit(1);
  }

  // Parse CLI options
  const extractContent = !args.includes('--no-extract');
  const maxResultsMatch = args.find(arg => arg.startsWith('--max-results='));
  const maxResults = maxResultsMatch ? parseInt(maxResultsMatch.split('=')[1]) || 3 : 3;

  // Remove options from query
  const cleanQuery = args.filter(arg => !arg.startsWith('--')).join(' ');

  console.log(`Enhanced search for: "${cleanQuery}"`);
  console.log(`Extract content: ${extractContent}, Max results: ${maxResults}`);

  try {
    const result = await enhancedWebSearch({
      query: cleanQuery,
      extractContent,
      maxResults
    });

    console.log('\n' + '='.repeat(50));
    console.log('ENHANCED WEB SEARCH RESULTS');
    console.log('='.repeat(50));
    console.log(`Summary: ${result.summary}`);
    console.log(`Stats: ${JSON.stringify(result.stats, null, 2)}`);

    result.extractedContent.forEach((item, index) => {
      console.log(`\n${index + 1}. ${item.title}`);
      console.log(`   URL: ${item.url}`);
      console.log(`   Description: ${item.description}`);

      if (item.contentExtracted && item.extractedContent) {
        console.log(`   Content extracted: Yes (${item.extractedContent.wordCount} words)`);
        console.log(`   Content preview: ${item.extractedContent.content.substring(0, 200)}...`);
      } else {
        console.log('   Content extracted: No');
        if (item.extractionError) {
          console.log(`   Extraction error: ${item.extractionError}`);
        }
      }
    });
  } catch (error) {
    console.error('Error performing enhanced search:', error.message);
    process.exit(1);
  }
}
