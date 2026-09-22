/**
 * Sources behind a grounded answer, as one flat list for the chat UI.
 *
 * Provider grounding metadata comes in two shapes:
 *  - Anthropic web search: `citations[]` ({ url, title, cited_text }) — what
 *    the answer actually cites — and `searchResults[]` ({ url, title }) — what
 *    was searched.
 *  - Google Search grounding: `groundingChunks[]` ({ web: { uri, title } }).
 *
 * Cited sources win; the raw search results only stand in when the provider
 * attached no citations at all. Entries are deduplicated by URL.
 *
 * @module features/chat/groundingSources
 */

/**
 * @param {Object|Object[]|null|undefined} metadata - one grounding metadata object or several
 * @returns {Array<{url: string, title?: string, citedText?: string}>}
 */
export function extractGroundingSources(metadata) {
  const list = Array.isArray(metadata) ? metadata : [metadata];
  const cited = new Map();
  const searched = new Map();

  const add = (map, url, title, citedText) => {
    if (typeof url !== 'string' || !url) return;
    const existing = map.get(url);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.citedText && citedText) existing.citedText = citedText;
      return;
    }
    const entry = { url };
    if (typeof title === 'string' && title) entry.title = title;
    if (typeof citedText === 'string' && citedText) entry.citedText = citedText;
    map.set(url, entry);
  };

  for (const meta of list) {
    if (!meta || typeof meta !== 'object') continue;
    for (const citation of meta.citations || []) {
      add(cited, citation?.url, citation?.title, citation?.cited_text);
    }
    for (const chunk of meta.groundingChunks || []) {
      add(cited, chunk?.web?.uri, chunk?.web?.title);
    }
    for (const result of meta.searchResults || []) {
      add(searched, result?.url, result?.title);
    }
  }

  return cited.size > 0 ? [...cited.values()] : [...searched.values()];
}

/**
 * Display hostname of a URL (without a leading `www.`); the URL itself when
 * it cannot be parsed.
 * @param {string} url
 * @returns {string}
 */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return typeof url === 'string' ? url : '';
  }
}
