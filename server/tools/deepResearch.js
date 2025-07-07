import braveSearch from './braveSearch.js';
import webContentExtractor from './webContentExtractor.js';
import { actionTracker } from '../actionTracker.js';
import queryRewriter from './queryRewriter.js';
import finalizer from './finalizer.js';
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
 *   - refineTemperature: Temperature for the query refinement
 */
export default async function deepResearch({
  query,
  maxRounds = 1,
  maxResults = 3,
  contentMaxLength = 3000,
  chatId,
  model = 'gemini-1.5-flash',
  refineTemperature = 0.5
}) {
  if (!query) {
    throw new Error('query parameter is required');
  }

  const sendProgress = (event, data) => {
    actionTracker.trackAction({ action: event, chatId, ...data });
  };

  sendProgress('research-start', { query });
  const aggregated = [];
  const queryQueue = [];
  const executed = new Set();
  const visitedUrls = new Set();

  // Use query rewriter to generate multiple search queries
  try {
    const rewrite = await queryRewriter({ query, chatId });
    if (rewrite && Array.isArray(rewrite.queries)) {
      for (const q of rewrite.queries) {
        const qs = typeof q === 'string' ? q : q.q;
        if (qs && !queryQueue.includes(qs)) {
          queryQueue.push(qs);
        }
      }
      sendProgress('research-query-rewrite', { originalQuery: query, newQueries: queryQueue });
    }
  } catch (err) {
    sendProgress('research-error', { message: `Failed to rewrite query: ${err.message}` });
  }

  if (queryQueue.length === 0) {
    queryQueue.push(query);
  }
  let round = 0;
  let currentQuery = queryQueue.shift();
  while (round < maxRounds && currentQuery) {
    round += 1;
    sendProgress('research-round', { round, query: currentQuery });
    executed.add(currentQuery);
    const search = await braveSearch({ query: currentQuery, chatId });
    sendProgress('research-results', { round, count: search.results.length });

    const results = search.results.slice(0, maxResults);
    for (const result of results) {
      if (visitedUrls.has(result.url)) {
        sendProgress('research-skip', { round, url: result.url, reason: 'already visited' });
        continue;
      }
      visitedUrls.add(result.url);
      sendProgress('research-fetch', { round, url: result.url });
      try {
        const extracted = await webContentExtractor({ url: result.url, maxLength: contentMaxLength, chatId });
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

        const trimmed = refinedQuery.trim();
        if (trimmed && !executed.has(trimmed) && !queryQueue.includes(trimmed)) {
          queryQueue.push(trimmed);
        }
        sendProgress('research-refined', { round, newQuery: trimmed });
      } catch (err) {
        sendProgress('research-error', { round, message: `Failed to refine query: ${err.message}` });
      }
    }

    currentQuery = queryQueue.shift();
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

  let finalAnswer = '';
  try {
    sendProgress('research-finalizing', { sources: aggregated.length });
    finalAnswer = await finalizer({ question: query, results: aggregated, model });
    sendProgress('research-finalized', { length: finalAnswer.length });
  } catch (err) {
    console.error('Failed to finalize answer:', err);
  }

  return {
    query,
    sources: aggregated,
    sourceSummary: `Found ${aggregated.length} sources for query "${query}":\n\n${sourceSummary}`,
    instruction: "IMPORTANT: When presenting your findings, always include the source URLs from the sources array. Each source has a 'url' field that must be cited in your response.",
    finalAnswer
  };
}
