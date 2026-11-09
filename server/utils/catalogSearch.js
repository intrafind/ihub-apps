// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The keyword search behind the two "find it yourself" tools the model gets
 * when a list would be too long for the prompt: `find_skill` (the skills) and
 * `search_tools` (the tools of the integrations). One ranking for both, with
 * no embedding service behind it.
 *
 * @module utils/catalogSearch
 */

/** Words of a query that count: lower case, at least two characters, each once. */
export function queryWords(query) {
  return [
    ...new Set(
      String(query || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(word => word.length >= 2)
    )
  ];
}

/**
 * The catalog entries that match `query` best: each word of at least two
 * characters counts three times in the name and once in the description. Ties
 * keep the catalog order. A query without such a word matches nothing.
 *
 * @param {Array<{name: string, displayName?: string, description?: string}>} entries
 * @param {string} query
 * @param {number} limit - Most entries returned
 * @returns {Array<Object>} The matching entries, best first
 */
export function searchCatalog(entries, query, limit) {
  const words = queryWords(query);
  if (words.length === 0 || !Array.isArray(entries)) return [];
  return entries
    .map((entry, index) => {
      const name = `${entry.name} ${entry.displayName || ''}`.toLowerCase();
      const description = String(entry.description || '').toLowerCase();
      const score = words.reduce(
        (sum, word) => sum + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0),
        0
      );
      return { entry, score, index };
    })
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(match => match.entry);
}
