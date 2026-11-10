// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import searchWithExtraction from './lib/searchWithExtraction.js';
import { STAAN_PAGE_SIZE, STAAN_MAX_WEB_RESULTS } from '../services/search/staanProvider.js';

/**
 * Perform a web search using Staan (staan.ai), with optional content extraction.
 *
 * Shares its contract with `braveSearch` and `qwantSearch`, so an app can swap
 * `websearch.provider` without the model seeing a different tool. Staan scopes
 * domains natively — `includeDomains` restricts the search to a set of sites,
 * `excludeDomains` (Staan only) drops them — where the other two fall back to
 * `site:` operators in the query.
 *
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {boolean} [params.extractContent=false] - Whether to extract full content from result pages
 * @param {number} [params.maxResults=10] - Maximum results to return / pages to extract (Staan pages in tens; more than ten costs one request per further page)
 * @param {number} [params.contentMaxLength=3000] - Maximum characters of extracted content per page
 * @param {string} [params.focus] - The question being researched: with `extractContent`, a long page returns the sections that answer it
 * @param {string} [params.language] - Language/locale for the results (e.g. "de", "en-GB")
 * @param {string} [params.freshness] - Only results from the last `day` | `week` | `month` | `year`
 * @param {string[]|string} [params.includeDomains] - Restrict results to these domains (max 10)
 * @param {string[]|string} [params.excludeDomains] - Drop results from these domains (max 10)
 * @param {string} [params.chatId] - The chat ID for context tracking
 * @returns {Promise<Object>} Search results, optionally with extracted page content
 * @throws {Error} If no query is provided
 */
export default async function staanSearch({
  query,
  q,
  extractContent = false,
  maxResults = STAAN_PAGE_SIZE,
  contentMaxLength = 3000,
  focus,
  language,
  freshness,
  includeDomains,
  excludeDomains,
  chatId
}) {
  const searchQuery = query || q;

  if (!searchQuery) {
    throw new Error('query parameter is required (use "query" or "q")');
  }

  // Staan serves at most four pages of ten. Asking for more would silently
  // return the maximum anyway, so the cap is applied up front and the model is
  // told the real number in the tool description.
  const limit = Math.min(Number(maxResults) || STAAN_PAGE_SIZE, STAAN_MAX_WEB_RESULTS);

  return searchWithExtraction({
    query: searchQuery,
    provider: 'staan',
    component: 'StaanSearch',
    extractContent,
    maxResults: limit,
    contentMaxLength,
    focus,
    freshness,
    includeDomains,
    chatId,
    searchOptions: { language, count: limit, excludeDomains }
  });
}
