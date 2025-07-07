import braveSearch from './braveSearch.js';
import webContentExtractor from './webContentExtractor.js';
import { actionTracker } from '../../shared/actionTracker.js';
import { simpleCompletion } from '../utils.js';

/**
 * Perform iterative web research with progress updates via SSE.
 * Parameters:
 *   - query: search query
 *   - maxRounds: number of search/refine iterations (default 1)
 *   - maxResults: number of search results per round (default 3)
 *   - contentMaxLength: max characters to extract per page (default 3000)
 *   - chatId: SSE chat session id for progress events
 *   - model: The language model to use for analysis and refinement
 *   - analysisTemperature: Temperature for the initial query analysis
 *   - refineTemperature: Temperature for the query refinement
 */
export default async function deepResearch({
  query,
  maxRounds = 1,
  maxResults = 3,
  contentMaxLength = 3000,
  chatId,
  model = 'gemini-1.5-flash',
  analysisTemperature = 0.2,
  refineTemperature = 0.5
}) {
  if (!query) {
    throw new Error('query parameter is required');
  }

  const sendProgress = (event, data) => {
    actionTracker.trackAction({ thisStep: { action: event, chatId, ...data } });
  };

  sendProgress('research-start', { query });
  const aggregated = [];
  let currentQuery = query;

  // Analyze the initial query to extract keywords for a better first search
  try {
    const analysisPrompt = `Analyze the following user query and extract the most relevant keywords for a web search. Return only the keywords, separated by spaces. Query: "${query}"`;
    const analysisResponse = await simpleCompletion(analysisPrompt, { temperature: analysisTemperature, model });
    const keywords = analysisResponse.trim();
    if (keywords) {
      currentQuery = keywords;
      sendProgress('research-query-analysis', { originalQuery: query, keywords });
    }
  } catch (err) {
    sendProgress('research-error', { message: `Failed to analyze query: ${err.message}` });
    // Proceed with the original query if analysis fails
  }

  for (let round = 1; round <= maxRounds; round++) {
    sendProgress('research-round', { round, query: currentQuery });
    const search = await braveSearch({ query: currentQuery });
    sendProgress('research-results', { round, count: search.results.length });

    const results = search.results.slice(0, maxResults);
    for (const result of results) {
      sendProgress('research-fetch', { round, url: result.url });
      try {
        const extracted = await webContentExtractor({ url: result.url, maxLength: contentMaxLength });
        const content = extracted.content || '';
        // Ensure we're including all relevant information for proper citation
        const sourceItem = { 
          url: result.url, 
          title: result.title || extracted.title || 'No title', 
          content: content,
          description: result.description || extracted.description || '',
          extractedAt: extracted.extractedAt || new Date().toISOString()
        };
        aggregated.push(sourceItem);
        console.log(`Added source: ${sourceItem.url} - ${sourceItem.title}`);
        sendProgress('research-fetched', { round, url: result.url, title: sourceItem.title });
      } catch (err) {
        sendProgress('research-error', { round, url: result.url, message: err.message });
      }
    }

    // If it's not the last round, analyze content and refine the query
    if (round < maxRounds && aggregated.length > 0) {
      try {
        const contentSummary = aggregated.map(item => `URL: ${item.url}\nTitle: ${item.title}\nContent: ${item.content}`).join('\n\n---\n\n');
        const refinePrompt = `Based on the initial query "${query}" and the following research content, generate a new, more specific search query to find deeper information. Return only the new search query.\n\n<content>\n${contentSummary}\n</content>`;
        
        sendProgress('research-refine', { round });
        const refinedQuery = await simpleCompletion(refinePrompt, { temperature: refineTemperature, model });
        
        if (refinedQuery && refinedQuery.trim() !== currentQuery) {
          currentQuery = refinedQuery.trim();
          sendProgress('research-refined', { round, newQuery: currentQuery });
        } else {
          // If the query doesn't change, no need for more rounds
          sendProgress('research-complete', { sources: aggregated.length, message: "Query refinement did not produce a new query. Concluding research." });
          return { query, sources: aggregated };
        }
      } catch (err) {
        sendProgress('research-error', { round, message: `Failed to refine query: ${err.message}` });
        // Stop if refinement fails
        sendProgress('research-complete', { sources: aggregated.length, message: "Stopping due to an error during query refinement." });
        return { query, sources: aggregated };
      }
    }
  }

  sendProgress('research-complete', { sources: aggregated.length });
  
  // Log the final result structure for debugging
  console.log(`Deep research completed. Query: "${query}", Sources found: ${aggregated.length}`);
  aggregated.forEach((source, index) => {
    console.log(`Source ${index + 1}: ${source.url} - "${source.title}"`);
  });
  
  // Create a detailed summary for the AI that emphasizes the URLs
  const sourceSummary = aggregated.map((source, index) => 
    `${index + 1}. "${source.title}" - ${source.url}\n   Content: ${source.content.substring(0, 200)}...`
  ).join('\n\n');
  
  return { 
    query, 
    sources: aggregated,
    sourceSummary: `Found ${aggregated.length} sources for query "${query}":\n\n${sourceSummary}`,
    instruction: "IMPORTANT: When presenting your findings, always include the source URLs from the sources array. Each source has a 'url' field that must be cited in your response."
  };
}
