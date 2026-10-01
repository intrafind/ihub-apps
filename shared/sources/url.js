/**
 * URL helpers every part of the sources contract compares and renders links
 * with. Pure functions, no DOM and no Node APIs.
 *
 * @module shared/sources/url
 */

const MAX_URL_CHARS = 2048;

/** Query parameters that only track a click, dropped when URLs are compared. */
const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref_src|srsltid)$/i;

/**
 * The URL if it is an http(s) URL of sane length, else null. Nothing else is
 * ever opened in the user's browser or rendered as a link.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function httpUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The key two URLs are compared by: host without `www.`, path without a
 * trailing slash, query without tracking parameters, no fragment, no scheme.
 * So `https://www.example.com/a/?utm_source=openai` and
 * `http://example.com/a` are the same source.
 *
 * @param {string} url
 * @returns {string|null} null when it is not an http(s) URL
 */
export function urlKey(url) {
  const href = httpUrl(
    typeof url === 'string' ? url.replace(/%28/gi, '(').replace(/%29/gi, ')') : url
  );
  if (!href) return null;
  const parsed = new URL(href);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let path = parsed.pathname.replace(/%28/gi, '(').replace(/%29/gi, ')');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';
  const params = [...parsed.searchParams.entries()].filter(([name]) => !TRACKING_PARAM.test(name));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${host}${port}${path}${query}`;
}

/**
 * Display host of a URL, without `www.`.
 *
 * @param {string} url
 * @returns {string} '' when it cannot be parsed
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * A URL as a Markdown link destination: parentheses and spaces encoded so the
 * link does not end early.
 *
 * @param {string} url
 * @returns {string}
 */
export function markdownLinkUrl(url) {
  return String(url).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
}
