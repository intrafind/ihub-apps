// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 *     (`read_url`)
 *
 * What the platform's own web search returned is public — it is on the open
 * web. "Own" is the shipped Brave, Qwant and Staan engines, decided by the
 * definition or script a tool runs. A third-party web search engine (an
 * integration of type `web-search`) and any other tool named after a search
 * engine (an MCP server, a custom or OpenAPI tool) may search anything,
 * intranet included:
 * its hits are listed the same way but stay private, unless its definition declares them public (`"sources": {
 * …, "public": true }`, `producers/declared.js`). What the page reader read is
 * private unless a public search returned it too: hosts on the SSL whitelist
 * bypass the reader's private-address guard, so a page it read may be an
 * intranet one.
 *
 * @module services/sources/producers/web
 */

import {
  isBuiltInWebSearchEngineTool,
  isWebSearchEngineTool
} from '../../search/webSearchEngines.js';

/** Tool id of the page reader. */
export const PAGE_READER_TOOL_ID = 'read_url';

/**
 * Web search tools: the shipped engines' search tools (`braveSearch`,
 * `staanSearch`, `qwantSearch`), the generic `webSearch` id, and MCP or custom
 * tools named after a web search engine. (The search tool of a third-party
 * engine is recognised by its definition's type instead, see `matches`.) Other tools that search something (Jira, people,
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
  return (
    id.startsWith('ifinder') ||
    id.startsWith('source_') ||
    id.startsWith('knowledge_') ||
    id.startsWith('app__')
  );
}

/**
 * @param {string} toolId
 * @returns {boolean}
 */
export function isWebSearchTool(toolId) {
  return !isOtherTool(toolId) && WEB_SEARCH_TOOL.test(String(toolId || ''));
}

/**
 * The platform's own web search scripts (`server/tools/`, shipped with the
 * server): the only tools whose hits are known to come from the open web.
 */
const BUILT_IN_WEB_SEARCH_SCRIPTS = new Set(['braveSearch.js', 'qwantSearch.js', 'staanSearch.js']);

/** Tool ids `runTool` dispatches by id, before it looks at a script. */
const DISPATCHED_BY_ID =
  /^(app__|workflow_|source_)|^(activate_skill|read_skill_resource|find_skill)$/;

/**
 * Whether the call ran one of the platform's own web search scripts: the
 * `search` action of a shipped engine (`com.intrafind/brave-search`, … — the
 * way they ship), or a tool file that still runs one of the scripts. Decided by what the
 * definition runs, the way `runTool` dispatches it, and never by
 * the tool's id or name: a custom, OpenAPI, MCP or A2A tool called
 * `braveSearch` runs something else.
 *
 * @param {string} toolId
 * @param {Object} [toolDef]
 * @returns {boolean}
 */
function isBuiltInWebSearch(toolId, toolDef) {
  if (!toolDef || DISPATCHED_BY_ID.test(String(toolId || ''))) return false;
  if (toolDef._mcp || toolDef._a2a || toolDef.type === 'openapi' || toolDef.isSpecialTool) {
    return false;
  }
  if (toolDef._integration) return isBuiltInWebSearchEngineTool(toolDef);
  return BUILT_IN_WEB_SEARCH_SCRIPTS.has(toolDef.script);
}

/** Whether the tool is the page reader, which reads one page rather than searching. */
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

/** What a web search looked for, whatever the provider calls the argument. */
function queryOf(args) {
  if (!args || typeof args !== 'object') return null;
  const query = args.query ?? args.q ?? args.searchQuery ?? args.searchTerm;
  return typeof query === 'string' && query.trim() ? query : null;
}

/** One web search hit as a page source. */
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
    ...fields
  };
}

/**
 * What a focused page read reported beside its result: the passages the model
 * was given. They merge into the page's own source by URL. A page the reader was
 * asked for is private, as everything it reads; a page a search extracted carries
 * the privacy of that search's hits (an own engine's are public), so the merge
 * does not turn a public hit private.
 */
function reportedWebItems(reader, reported, hitPrivacy) {
  if (!Array.isArray(reported)) return [];
  return reported
    .filter(item => item?.provider === 'web')
    .map(item => (reader ? item : { ...item, ...hitPrivacy }));
}

/** The list of hits a search result carries, whatever the provider calls it; null when it has none. */
function hitListOf(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return null;
  return [result.results, result.items, result.sources].find(Array.isArray) ?? null;
}

export const webSourceProducer = {
  id: 'web',

  /**
   * What the server says the call came to, from the full result: how many
   * hits a search returned, and whether a page read delivered any text. Left
   * out when the result does not say (an unknown shape, a failed call): an
   * empty source list is not "no results", a provider-run search has none by
   * construction.
   *
   * @param {{toolId: string, result: unknown, failed?: boolean}} call
   * @returns {{resultCount?: number, readOutcome?: 'opened'|'empty'}}
   */
  outcomeOf({ toolId, result, failed }) {
    if (failed || !result || typeof result !== 'object' || result.error) return {};
    if (isPageReader(toolId)) {
      return typeof result.content === 'string'
        ? { readOutcome: result.content.trim() ? 'opened' : 'empty' }
        : {};
    }
    const hits = hitListOf(result);
    return hits ? { resultCount: hits.length } : {};
  },

  /** @param {{toolId: string, toolDef?: Object}} call */
  matches({ toolId, toolDef }) {
    return isPageReader(toolId) || isWebSearchTool(toolId) || isWebSearchEngineTool(toolDef);
  },

  /**
   * @param {{toolId: string, toolDef?: Object, args?: Object, result: unknown, reported?: Array, failed?: boolean}} call -
   *   `result` parsed from JSON text already
   * @returns {{items: Array, queries: string[]}}
   */
  fromToolResult({ toolId, toolDef, args, result, reported = [], failed }) {
    const reader = isPageReader(toolId);
    const hitPrivacy = { private: !isBuiltInWebSearch(toolId, toolDef) };
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
        if (item && typeof item === 'object') {
          items.push(asSource(item, { ...hitPrivacy, ...fields?.(item) }));
        }
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
            private: reader || hitPrivacy.private
          })
        );
      }
    }
    items.push(...reportedWebItems(reader, reported, hitPrivacy));
    return { items, queries };
  }
};
