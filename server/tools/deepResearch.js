import braveSearch from './braveSearch.js';
import webContentExtractor from './webContentExtractor.js';
import { sendSSE, clients } from '../sse.js';

/**
 * Perform iterative web research with progress updates via SSE.
 * Parameters:
 *   - query: search query
 *   - maxRounds: number of search/refine iterations (default 1)
 *   - maxResults: number of search results per round (default 3)
 *   - contentMaxLength: max characters to extract per page (default 3000)
 *   - chatId: SSE chat session id for progress events
 */
export default async function deepResearch({
  query,
  maxRounds = 1,
  maxResults = 3,
  contentMaxLength = 3000,
  chatId
}) {
  if (!query) {
    throw new Error('query parameter is required');
  }

  const sendProgress = (event, data) => {
    if (chatId && clients.has(chatId)) {
      const client = clients.get(chatId).response;
      sendSSE(client, event, data);
    }
  };

  sendProgress('research-start', { query });
  const aggregated = [];
  let currentQuery = query;

  for (let round = 1; round <= maxRounds; round++) {
    sendProgress('research-round', { round, query: currentQuery });
    const search = await braveSearch({ query: currentQuery });
    sendProgress('research-results', { round, count: search.results.length });

    const results = search.results.slice(0, maxResults);
    for (const result of results) {
      sendProgress('research-fetch', { round, url: result.url });
      try {
        const content = await webContentExtractor({ url: result.url, maxLength: contentMaxLength });
        aggregated.push({ url: result.url, title: result.title, content });
        sendProgress('research-fetched', { round, url: result.url });
      } catch (err) {
        sendProgress('research-error', { round, url: result.url, message: err.message });
      }
    }
    // Simple implementation without automatic query refinement
  }

  sendProgress('research-complete', { sources: aggregated.length });
  return { query, sources: aggregated };
}
