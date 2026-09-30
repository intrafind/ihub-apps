/**
 * Source producer for web search tools and the page reader.
 *
 * The client only ever sees a bounded preview of a tool result, and a web
 * search that extracted page content blows past that bound on its first
 * result, so the sources are taken from the full result here. Result shapes:
 *
 *   - an array of `{ url, title? }`
 *   - `{ results: [...] }`, optionally with `extractedContent: [{ url, contentExtracted }]`
 *     (`tools/lib/searchWithExtraction.js`)
 *   - `{ items: [...] }` / `{ sources: [...] }`
 *   - a single fetched page `{ url, title?, content, wordCount?, truncated?, incomplete? }`
 *     (`webContentExtractor`)
 *
 * What a search returned is public — it is on the open web. What the page
 * reader read is private unless a search returned it too: hosts on the SSL
 * whitelist bypass the reader's private-address guard, so a page it read may
 * be an intranet one.
 *
 * @module services/sources/producers/web
 */

/** Tool id of the page reader. */
export const PAGE_READER_TOOL_ID = 'webcontentextractor';

/**
 * Web search tools: the script-backed ones (`braveSearch`, `staanSearch`,
 * `qwantSearch`), the generic `webSearch` id, and MCP or custom tools named
 * after a web search engine. Other tools that search something (Jira, people,
 * documents) are not web search, even though their results carry URLs; they
 * report sources through the envelope or a declaration.
 */
const WEB_SEARCH_TOOL =
  /web_?search|internet_?search|brave|qwant|staan|tavily|serp|bing|duckduckgo/i;

/**
 * Tools whose results are never web search results: the organisation's
 * documents, and apps invoked as tools (they report their own sources).
 */
function isOtherTool(toolId) {
  const id = String(toolId || '').toLowerCase();
  return id.startsWith('ifinder') || id.startsWith('source_') || id.startsWith('app__');
}

/**
 * @param {string} toolId
 * @returns {boolean}
 */
export function isWebSearchTool(toolId) {
  return !isOtherTool(toolId) && WEB_SEARCH_TOOL.test(String(toolId || ''));
}

function isPageReader(toolId) {
  return String(toolId || '').toLowerCase() === PAGE_READER_TOOL_ID;
}

/**
 * First link on a result item: providers name it differently.
 * @returns {string|undefined}
 */
function linkOf(item) {
  return [item.url, item.link, item.href, item.uri].find(
    value => typeof value === 'string' && value
  );
}

function queryOf(args) {
  if (!args || typeof args !== 'object') return null;
  const query = args.query ?? args.q ?? args.searchQuery ?? args.searchTerm;
  return typeof query === 'string' && query.trim() ? query : null;
}

function asSource(item, fields = {}) {
  return {
    provider: 'web',
    kind: 'page',
    url: linkOf(item),
    title: item.title || item.name || item.heading,
    snippet: [item.description, item.snippet, item.excerpt].find(
      value => typeof value === 'string' && value.trim()
    ),
    publishedDate: item.publishedDate ?? item.published_date ?? item.date,
    favicon: item.favicon,
    private: false,
    ...fields
  };
}

export const webSourceProducer = {
  id: 'web',

  /** @param {{toolId: string}} call */
  matches({ toolId }) {
    return isPageReader(toolId) || isWebSearchTool(toolId);
  },

  /**
   * @param {{toolId: string, args?: Object, result: unknown, failed?: boolean}} call -
   *   `result` parsed from JSON text already
   * @returns {{items: Array, queries: string[]}}
   */
  fromToolResult({ toolId, args, result, failed }) {
    const reader = isPageReader(toolId);
    const queries = reader ? [] : [queryOf(args)].filter(Boolean);
    if (failed || !result || typeof result !== 'object' || result.error) {
      // A page read that failed is still a page the turn tried.
      const url = reader ? (args?.url ?? args?.uri ?? args?.link) : null;
      return {
        items:
          failed && url
            ? [{ provider: 'web', kind: 'page', url, read: { ok: false }, private: true }]
            : [],
        queries
      };
    }

    const items = [];
    const addAll = (list, fields) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (item && typeof item === 'object') items.push(asSource(item, fields?.(item)));
      }
    };

    if (Array.isArray(result)) {
      addAll(result);
    } else {
      addAll(result.results);
      addAll(result.items);
      addAll(result.sources);
      // Pages the search went on to fetch: whether each one could be read.
      addAll(result.extractedContent, item => ({
        read: { ok: item.contentExtracted === true }
      }));
      // A single fetched page: what the page reader read of it.
      if (typeof result.url === 'string' && typeof result.content === 'string') {
        items.push(
          asSource(result, {
            // The reader's `content` is the page, not an excerpt.
            snippet: undefined,
            read: {
              ok: true,
              words: Number.isInteger(result.wordCount) ? result.wordCount : undefined,
              // Either more to read at `nextOffset`, or more than the reader keeps.
              truncated: result.truncated === true || result.incomplete === true
            },
            private: reader
          })
        );
      }
    }
    return { items, queries };
  }
};
