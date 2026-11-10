// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import searchWithExtraction from './lib/searchWithExtraction.js';

/**
 * Perform a web search using the Brave Search API, with optional content extraction.
 * @param {Object} params - The search parameters
 * @param {string} [params.query] - The search query
 * @param {string} [params.q] - Alternative query parameter name
 * @param {boolean} [params.extractContent=false] - Whether to extract full content from result pages
 * @param {number} [params.maxResults=10] - Maximum number of results to return / pages to extract
 * @param {number} [params.contentMaxLength=3000] - Maximum characters of extracted content per page
 * @param {string} [params.focus] - The question being researched: with `extractContent`, a long page returns the sections that answer it
 * @param {string} [params.language] - Language/locale for the results (e.g. "de", "en-GB")
 * @param {string} [params.freshness] - Only results from the last `day` | `week` | `month` | `year`
 * @param {string[]|string} [params.includeDomains] - Restrict results to these domains (max 10)
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

  return searchWithExtraction({
    query: searchQuery,
    provider: 'brave',
    component: 'BraveSearch',
    extractContent,
    maxResults,
    contentMaxLength,
    focus,
    freshness,
    includeDomains,
    chatId,
    searchOptions: { language }
  });
}
