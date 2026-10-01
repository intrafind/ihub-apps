/**
 * Display helpers for the sources behind a chat answer. The sources themselves
 * — web search results, page reads and provider grounding — are collected by
 * `shared/sources`.
 *
 * @module shared/run/groundingSources
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
