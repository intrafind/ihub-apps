/**
 * The web sources behind a chat answer and which of them it cites — one model
 * for every search path, shared by the server (what is stored with the
 * answer) and the client (what the sources view and the inline citations
 * show).
 *
 *   buildWebSearch({ tools, grounding }) → { queries, sources, supports } | null
 *   resolveCitations(markdown, webSearch) → { cited, considered, numbers }
 *   insertSupportMarkers(text, supports)  → text with citation markers
 *
 * ## Where sources come from
 *
 *  - Script-backed search (Brave, Staan, Qwant) and the page reader: the
 *    turn's tool calls, each with the `webSources` the server extracted from
 *    its full result (`server/services/loop/webSources.js`) and the query it
 *    was called with.
 *  - Provider-run search: the step's `groundingMetadata` —
 *    Anthropic `searchResults` / `citations` (`cited_text`), Google
 *    `groundingChunks` / `webSupports`, OpenAI Responses `searchResults` /
 *    `citations` (`url_citation`), and every provider's `webSearchQueries`.
 *
 * ## Citation markers
 *
 * A citation is a Markdown link to one of the turn's sources, conventionally
 * `[n](url)`. The number the model writes does not matter: sources are
 * numbered in the order the answer first links them, which is what the badge
 * shows. A link to a URL the turn's searches and page reads did not return is
 * left an ordinary link and never becomes a citation. Links hold up when the
 * answer is copied, which bare `[n]` indices would not.
 *
 *  - Script-backed search: the research guidance asks the model to cite so.
 *  - OpenAI: the model writes the links itself (its `url_citation`s point at them).
 *  - Anthropic: the converter appends a marker after each cited text block
 *    ({@link citationMarkers}).
 *  - Google: the answer text carries no links; its grounding supports name the
 *    passage each source backs, and {@link insertSupportMarkers} places the
 *    markers after those passages.
 *
 * Pure functions only, no DOM and no Node APIs, so both sides import it.
 *
 * @module shared/webCitations
 */

/** Most sources kept for one answer. */
export const MAX_WEB_SEARCH_SOURCES = 100;
/** Most queries kept for one answer. */
export const MAX_WEB_SEARCH_QUERIES = 30;

const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 400;
const MAX_CITED_TEXT_CHARS = 500;
const MAX_QUERY_CHARS = 300;
const MAX_URL_CHARS = 2048;

/** Query parameters that only track a click, dropped when URLs are compared. */
const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref_src|srsltid)$/i;

function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * The URL if it is an http(s) URL of sane length, else null.
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
export function sourceKey(url) {
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
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Google's grounding links point through a redirect; its title is the site. */
function isGroundingRedirect(url) {
  return /(^|\.)vertexaisearch\.cloud\.google\.com$/i.test(hostOf(url));
}

/**
 * A URL as a Markdown link destination: parentheses and spaces encoded so the
 * link does not end early.
 * @param {string} url
 * @returns {string}
 */
export function markdownLinkUrl(url) {
  return String(url).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
}

/**
 * Citation markers for a set of URLs, numbered through `numbers` (URL → n,
 * extended as new URLs appear), e.g. `[1](https://a.example/)[2](…)`.
 *
 * @param {string[]} urls
 * @param {Map<string, number>} numbers - shared across the calls of one answer
 * @returns {string} '' when no URL is usable
 */
export function citationMarkers(urls, numbers) {
  const seen = new Set();
  let out = '';
  for (const raw of urls || []) {
    const url = httpUrl(raw);
    const key = url && sourceKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    out += `[${numbers.get(key)}](${markdownLinkUrl(url)})`;
  }
  return out;
}

/** Tool ids whose sources are the organisation's documents, not the web. */
function isDocumentTool(toolId) {
  const id = String(toolId || '').toLowerCase();
  return id.startsWith('ifinder') || id.startsWith('source_');
}

function isPageReader(toolId) {
  return String(toolId || '').toLowerCase() === 'webcontentextractor';
}

/**
 * Web search tools: the script-backed ones (`braveSearch`, `staanSearch`,
 * `qwantSearch`), the generic `webSearch` id, and MCP or custom tools named
 * after a web search engine. Other tools that search something (Jira, people,
 * documents) are not web search, even though their results carry URLs.
 */
const WEB_SEARCH_TOOL =
  /web_?search|internet_?search|brave|qwant|staan|tavily|serp|bing|duckduckgo/i;

/**
 * @param {string} toolId
 * @returns {boolean}
 */
export function isWebSearchTool(toolId) {
  return !isDocumentTool(toolId) && WEB_SEARCH_TOOL.test(String(toolId || ''));
}

function queryOf(args) {
  if (!args || typeof args !== 'object') return null;
  return text(args.query ?? args.q ?? args.searchQuery ?? args.searchTerm, MAX_QUERY_CHARS);
}

/**
 * Collect sources into one list, merged by {@link sourceKey}: the first
 * appearance fixes the position, later ones fill in what is missing.
 */
function createSourceList() {
  const byKey = new Map();
  const add = (url, fields = {}) => {
    const href = httpUrl(url);
    const key = href && sourceKey(href);
    if (!key) return null;
    let entry = byKey.get(key);
    if (!entry) {
      if (byKey.size >= MAX_WEB_SEARCH_SOURCES) return null;
      entry = { url: href };
      byKey.set(key, entry);
    }
    const title = text(fields.title, MAX_TITLE_CHARS);
    if (title && !entry.title) entry.title = title;
    const host = text(fields.host, MAX_TITLE_CHARS);
    if (host && !entry.host) entry.host = host;
    const snippet = text(fields.snippet, MAX_SNIPPET_CHARS);
    if (snippet && !entry.snippet) entry.snippet = snippet;
    const citedText = text(fields.citedText, MAX_CITED_TEXT_CHARS);
    if (citedText && !entry.citedText) entry.citedText = citedText;
    if (typeof fields.publishedDate === 'string' && !entry.publishedDate) {
      const time = Date.parse(fields.publishedDate);
      if (!Number.isNaN(time)) entry.publishedDate = new Date(time).toISOString();
    }
    const favicon = httpUrl(fields.favicon);
    if (favicon && !entry.favicon) entry.favicon = favicon;
    if (fields.read === true) {
      entry.read = true;
      delete entry.readFailed;
    } else if (fields.readFailed === true && !entry.read) {
      entry.readFailed = true;
    }
    if (Number.isInteger(fields.wordCount) && fields.wordCount >= 0) {
      entry.wordCount = Math.max(entry.wordCount || 0, fields.wordCount);
    }
    if (fields.truncated === true) entry.truncated = true;
    if (fields.cited === true) entry.cited = true;
    return entry;
  };
  return { add, values: () => [...byKey.values()] };
}

/**
 * The turn's web search: what was searched for, every source the searches and
 * page reads returned, and — for Google — which passage each source backs.
 *
 * @param {Object} input
 * @param {Array<{toolId: string, args?: Object, webSources?: Object[], status?: string,
 *   error?: unknown, result?: unknown}>} [input.tools] - the turn's tool calls
 * @param {Object|Object[]} [input.grounding] - provider grounding metadata, per step
 * @returns {{queries: string[], sources: Object[], supports: Array<{text: string, urls: string[]}>}|null}
 *   null when the turn searched and read nothing on the web
 */
export function buildWebSearch({ tools = [], grounding = [] } = {}) {
  const queries = [];
  const addQuery = value => {
    const query = text(value, MAX_QUERY_CHARS);
    if (query && !queries.includes(query) && queries.length < MAX_WEB_SEARCH_QUERIES) {
      queries.push(query);
    }
  };
  const sources = createSourceList();
  const supports = [];
  let searched = false;

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || isDocumentTool(tool.toolId)) continue;
    const reader = isPageReader(tool.toolId);
    if (!reader && !isWebSearchTool(tool.toolId)) continue;
    searched = true;
    if (!reader) addQuery(queryOf(tool.args));
    const list = Array.isArray(tool.webSources) ? tool.webSources : [];
    for (const source of list) {
      sources.add(source?.url, {
        title: source.title,
        snippet: source.snippet,
        publishedDate: source.publishedDate,
        favicon: source.favicon,
        read: source.read,
        readFailed: source.readFailed,
        wordCount: source.wordCount,
        truncated: source.truncated
      });
    }
    // A page read that failed, or that the per-turn cap refused, reported no
    // source — the URL it was asked for still is one the turn tried.
    if (reader && list.length === 0) {
      const url = tool.args?.url ?? tool.args?.uri ?? tool.args?.link;
      if (tool.status === 'error' || tool.error) sources.add(url, { readFailed: true });
    }
  }

  for (const meta of Array.isArray(grounding) ? grounding : [grounding]) {
    if (!meta || typeof meta !== 'object') continue;
    for (const query of Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries : []) {
      addQuery(query);
      searched = true;
    }
    for (const result of Array.isArray(meta.searchResults) ? meta.searchResults : []) {
      sources.add(result?.url, { title: result?.title, publishedDate: result?.page_age });
    }
    for (const citation of Array.isArray(meta.citations) ? meta.citations : []) {
      sources.add(citation?.url, {
        title: citation?.title,
        citedText: citation?.cited_text,
        cited: true
      });
    }
    for (const chunk of Array.isArray(meta.groundingChunks) ? meta.groundingChunks : []) {
      const web = chunk?.web;
      if (!web) continue;
      const redirect = isGroundingRedirect(web.uri);
      // Cited only when a support names it (below): a chunk no passage rests
      // on was retrieved, not cited.
      sources.add(web.uri, {
        title: web.title,
        // A redirect link says nothing about the site; Google names it in the title.
        host: web.domain || (redirect ? web.title : null)
      });
    }
    for (const support of Array.isArray(meta.webSupports) ? meta.webSupports : []) {
      const passage = typeof support?.text === 'string' ? support.text : '';
      const urls = (Array.isArray(support?.urls) ? support.urls : []).map(httpUrl).filter(Boolean);
      if (!passage.trim() || !urls.length) continue;
      supports.push({ text: passage, urls });
      for (const url of urls) sources.add(url, { cited: true });
    }
  }

  const list = sources.values();
  if (!searched && list.length === 0) return null;
  return { queries, sources: list, supports };
}

/** Fenced and inline code: links in there are code, not citations. */
function withoutCode(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

const LINK =
  /(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^()\s<>]+(?:\([^()\s]*\)[^()\s<>]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const BARE_URL = /<?(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]])>?/g;

/**
 * Every link target in a Markdown text, in order: `[text](url)` links first
 * claim their span, then autolinks and bare URLs in what remains.
 * @param {string} markdown
 * @returns {string[]}
 */
export function linkTargets(markdown) {
  const source = withoutCode(markdown);
  const found = [];
  const rest = source.replace(LINK, (match, bang, _label, url, offset) => {
    if (!bang) found.push({ offset, url });
    return ' '.repeat(match.length);
  });
  for (const match of rest.matchAll(BARE_URL)) {
    found.push({ offset: match.index, url: match[1] });
  }
  return found.sort((a, b) => a.offset - b.offset).map(entry => entry.url);
}

/**
 * Which of the turn's sources the answer cites, numbered in the order the
 * answer first links them, and which it only considered.
 *
 * A source a provider reported as cited (`cited`: Anthropic `citations`,
 * Google grounding chunks a support rests on, OpenAI `url_citation`s) counts
 * as cited even when the text links it nowhere, numbered after the linked ones.
 *
 * @param {string} markdown - the answer
 * @param {{sources?: Object[]}|null} webSearch - from {@link buildWebSearch}
 * @returns {{cited: Array<Object>, considered: Array<Object>, numbers: Map<string, number>}}
 *   `cited` entries carry their number as `n`; `numbers` maps
 *   {@link sourceKey} → n, for rendering the markers
 */
export function resolveCitations(markdown, webSearch) {
  const sources = Array.isArray(webSearch?.sources) ? webSearch.sources : [];
  const byKey = new Map();
  for (const source of sources) {
    const key = sourceKey(source?.url);
    if (key && !byKey.has(key)) byKey.set(key, source);
  }
  const numbers = new Map();
  const cited = [];
  const cite = (key, source) => {
    if (numbers.has(key)) return;
    numbers.set(key, cited.length + 1);
    cited.push({ ...source, n: cited.length + 1 });
  };
  for (const url of linkTargets(markdown)) {
    const key = sourceKey(url);
    if (key && byKey.has(key)) cite(key, byKey.get(key));
  }
  for (const [key, source] of byKey) {
    if (source.cited) cite(key, source);
  }
  const considered = [...byKey.entries()]
    .filter(([key]) => !numbers.has(key))
    .map(([, source]) => source);
  return { cited, considered, numbers };
}

/**
 * Place citation markers after the passages grounding supports name (Google
 * Search grounding, whose answer text has no links). Each passage is looked
 * for from where the previous one ended; a passage that is not found, or
 * that already has a marker for the same source right after it, is skipped,
 * so applying this twice changes nothing.
 *
 * @param {string} text - the answer
 * @param {Array<{text: string, urls: string[]}>} supports
 * @returns {string}
 */
export function insertSupportMarkers(text, supports) {
  const source = typeof text === 'string' ? text : '';
  if (!source || !Array.isArray(supports) || supports.length === 0) return source;
  const numbers = new Map();
  let out = '';
  let cursor = 0;
  for (const support of supports) {
    const passage = typeof support?.text === 'string' ? support.text : '';
    if (!passage.trim()) continue;
    const at = source.indexOf(passage, cursor);
    if (at < 0) continue;
    const end = at + passage.length;
    const markers = citationMarkers(support.urls, numbers);
    if (!markers) continue;
    const following = source.slice(end, end + markers.length + 1);
    out += source.slice(cursor, end);
    if (!following.trimStart().startsWith(markers)) out += markers;
    cursor = end;
  }
  return out + source.slice(cursor);
}

/**
 * The web search record as stored with an answer: queries and sources, no
 * supports (their markers are in the stored text already).
 * @param {Object|null} webSearch
 * @returns {{queries: string[], sources: Object[]}|null}
 */
export function storedWebSearch(webSearch) {
  if (!webSearch || typeof webSearch !== 'object') return null;
  const queries = (Array.isArray(webSearch.queries) ? webSearch.queries : [])
    .map(query => text(query, MAX_QUERY_CHARS))
    .filter(Boolean)
    .slice(0, MAX_WEB_SEARCH_QUERIES);
  const list = createSourceList();
  for (const source of Array.isArray(webSearch.sources) ? webSearch.sources : []) {
    if (source && typeof source === 'object') list.add(source.url, source);
  }
  const sources = list.values();
  return queries.length || sources.length ? { queries, sources } : null;
}
