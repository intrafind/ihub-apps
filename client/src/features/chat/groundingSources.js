/**
 * Display helpers for the sources behind a chat answer. The sources themselves
 * — web search results, page reads and provider grounding — are collected by
 * `shared/webCitations.js` (see `features/chat/webSearch.js`).
 *
 * @module features/chat/groundingSources
 */

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
