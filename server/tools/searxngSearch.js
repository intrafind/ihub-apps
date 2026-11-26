// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import searchWithExtraction from './lib/searchWithExtraction.js';
import {
  SEARXNG_DEFAULT_RESULTS,
  SEARXNG_MAX_WEB_RESULTS
} from '../services/search/searxngProvider.js';

/**
 * Perform a web search through the customer's own SearXNG instance, with
 * optional content extraction.
 *
 * Shares its contract with `braveSearch`, `staanSearch` and `qwantSearch`, so
 * an app can swap `websearch.provider` without the model seeing a different
 * tool. The instance is the installation's `instanceUrl`; nothing here names a
 * vendor endpoint. SearXNG has no date filter that covers every engine, so
 * `freshness` is sent as `time_range` (where its engines honour it) and the
 * shared search body drops dated results outside the window as well.
 *
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {boolean} [params.extractContent=false] - Whether to extract full content from result pages
 * @param {number} [params.maxResults=10] - Maximum results to return / pages to extract (at most 20)
 * @param {number} [params.contentMaxLength=3000] - Maximum characters of extracted content per page
 * @param {string} [params.focus] - The question being researched: with `extractContent`, a long page returns the sections that answer it
 * @param {string} [params.language] - Language/locale for the results (e.g. "de", "en-GB")
 * @param {string} [params.freshness] - Only results from the last `day` | `week` | `month` | `year`
 * @param {string[]|string} [params.includeDomains] - Restrict results to these domains (max 10; `site:` operators)
 * @param {string} [params.chatId] - The chat ID for context tracking
 * @returns {Promise<Object>} Search results, optionally with extracted page content
 * @throws {Error} If no query is provided
 */
export default async function searxngSearch({
  query,
  q,
  extractContent = false,
  maxResults = SEARXNG_DEFAULT_RESULTS,
  contentMaxLength = 3000,
  focus,
  language,
  freshness,
  includeDomains,
  chatId
}) {
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  const limit = Math.min(Number(maxResults) || SEARXNG_DEFAULT_RESULTS, SEARXNG_MAX_WEB_RESULTS);

  return searchWithExtraction({
    query: searchQuery,
    provider: 'searxng',
    component: 'SearxngSearch',
    extractContent,
    maxResults: limit,
    contentMaxLength,
    focus,
    freshness,
    includeDomains,
    chatId,
    searchOptions: { language, count: limit, timeRange: freshness }
  });
}
