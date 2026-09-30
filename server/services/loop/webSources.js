/**
 * The web pages behind a search or fetch tool call, as a short list the chat
 * can show.
 *
 * The client only ever sees a bounded preview of a tool result (see
 * `chatSeams.previewToolResult`), and a web search that extracted page content
 * blows past that bound on its first result — so the preview arrives as a
 * truncated string and the sources in it are lost. This reduces the full
 * result to what the chat renders instead: which pages the search found, and
 * which of them were actually read.
 *
 * The result shapes are the ones `PromptNodeExecutor._captureCitationsFromToolResult`
 * already harvests for agent runs:
 *   - an array of `{ url, title? }`
 *   - `{ results: [...] }`, optionally with `extractedContent: [{ url, contentExtracted }]`
 *     (`tools/lib/searchWithExtraction.js`)
 *   - `{ items: [...] }` / `{ sources: [...] }`
 *   - a single fetched page `{ url, title?, content }` (`webContentExtractor`)
 *   - iFinder hits `{ results: [{ id, title, url?, deepLink }] }` (`iFinder_search`)
 *   - an iFinder document `{ documentId, metadata: { title, url } }`
 *     (`iFinder_getContent`, read) or `{ id, title, deepLink }` (`iFinder_getMetadata`)
 *
 * iFinder sources carry their `documentId`, so a document a later
 * `iFinder_getContent` read can be matched to the hit that found it. A
 * document without a browser link is still listed, by title.
 *
 * @module services/loop/webSources
 */
import { isCitationProducingTool } from './toolClassify.js';

/** Most sources one tool call reports; a search is capped at 20 results. */
export const MAX_WEB_SOURCES = 25;
const MAX_TITLE_CHARS = 300;
/** Longest snippet kept for a source card. */
const MAX_SNIPPET_CHARS = 400;

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * First http(s) link on a result item. `deepLink` covers iFinder hits, whose
 * `url` is often the document's own location (`file://`, `smb://`) while the
 * deep link opens it in the browser.
 */
function linkOf(item) {
  for (const value of [item.url, item.link, item.href, item.uri, item.deepLink]) {
    const url = httpUrl(value);
    if (url) return url;
  }
  return null;
}

function titleOf(item) {
  let title = item.title || item.name || item.heading;
  // iFinder returns document fields as arrays.
  if (Array.isArray(title)) title = title.find(value => typeof value === 'string');
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, MAX_TITLE_CHARS) : null;
}

/**
 * Text without markup. Search engines mark the matched terms with HTML
 * (`<strong>`), and a source card shows text: everything from a `<` to the
 * next `>` is dropped, and neither bracket is ever kept, so a broken or nested
 * tag cannot leave markup behind.
 * @param {string} text
 * @returns {string}
 */
function stripTags(text) {
  let out = '';
  let inTag = false;
  for (const char of text) {
    if (char === '<') inTag = true;
    else if (char === '>') inTag = false;
    else if (!inTag) out += char;
  }
  return out;
}

function snippetOf(item) {
  const text = [item.description, item.snippet, item.excerpt].find(
    value => typeof value === 'string' && value.trim()
  );
  if (!text) return null;
  const plain = stripTags(text).replace(/\s+/g, ' ').trim();
  return plain ? plain.slice(0, MAX_SNIPPET_CHARS) : null;
}

function dateOf(item) {
  const value = item.publishedDate ?? item.published_date ?? item.date;
  if (typeof value !== 'string' || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function documentIdOf(item) {
  const id = item.documentId ?? item.id;
  if (typeof id === 'number') return String(id);
  return typeof id === 'string' && id && id.length <= 1024 ? id : null;
}

function isIFinderTool(toolId) {
  return String(toolId || '')
    .toLowerCase()
    .startsWith('ifinder');
}

function parse(result) {
  if (typeof result !== 'string') return result;
  const text = result.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {string} toolId - The tool that produced the result
 * @param {unknown} result - The tool's raw result (object, array or JSON text)
 * @returns {Array<{url?: string, documentId?: string, title?: string, snippet?: string,
 *   publishedDate?: string, favicon?: string, read?: boolean, readFailed?: boolean,
 *   wordCount?: number, truncated?: boolean}>}
 *   Sources in result order, deduplicated by URL (iFinder: by document id);
 *   empty for any other tool. Web sources carry what the chat's source cards
 *   show — the result's snippet, date and favicon — and a page read carries
 *   how many words were read and whether the page was cut.
 */
export function extractWebSources(toolId, result) {
  const iFinder = isIFinderTool(toolId);
  if (!iFinder && !isCitationProducingTool(toolId)) return [];
  const parsed = parse(result);
  if (!parsed || typeof parsed !== 'object' || parsed.error) return [];

  const byKey = new Map();
  const add = (item, read) => {
    if (!item || typeof item !== 'object') return;
    const url = linkOf(item);
    const documentId = iFinder ? documentIdOf(item) : null;
    if (!url && !documentId) return;
    const key = documentId ? `doc:${documentId}` : url;
    let entry = byKey.get(key);
    if (!entry) {
      if (byKey.size >= MAX_WEB_SOURCES) return;
      entry = {};
      if (url) entry.url = url;
      if (documentId) entry.documentId = documentId;
      byKey.set(key, entry);
    }
    const title = titleOf(item);
    if (title && !entry.title) entry.title = title;
    if (!iFinder) {
      const snippet = snippetOf(item);
      if (snippet && !entry.snippet) entry.snippet = snippet;
      const date = dateOf(item);
      if (date && !entry.publishedDate) entry.publishedDate = date;
      const favicon = httpUrl(item.favicon);
      if (favicon && !entry.favicon) entry.favicon = favicon;
    }
    if (read === true) {
      entry.read = true;
      delete entry.readFailed;
    } else if (read === false && !entry.read) {
      entry.readFailed = true;
    }
  };
  const addAll = (list, readOf = () => undefined) => {
    if (!Array.isArray(list)) return;
    for (const item of list) add(item, readOf(item));
  };

  if (Array.isArray(parsed)) {
    addAll(parsed);
  } else if (iFinder && !Array.isArray(parsed.results) && documentIdOf(parsed)) {
    // A single document: its content (read) or its metadata.
    const read = String(toolId).toLowerCase() === 'ifinder_getcontent' ? true : undefined;
    add({ ...(parsed.metadata || {}), ...parsed, documentId: documentIdOf(parsed) }, read);
  } else {
    addAll(parsed.results);
    addAll(parsed.items);
    addAll(parsed.sources);
    // Pages the search went on to fetch: whether each one could be read.
    addAll(parsed.extractedContent, item => item?.contentExtracted === true);
    // A single fetched page: what the page reader read of it.
    if (typeof parsed.url === 'string' && typeof parsed.content === 'string') {
      add(parsed, true);
      const entry = byKey.get(linkOf(parsed));
      if (entry) {
        if (Number.isInteger(parsed.wordCount) && parsed.wordCount >= 0) {
          entry.wordCount = parsed.wordCount;
        }
        // Either more to read at `nextOffset`, or more than the reader keeps.
        if (parsed.truncated === true || parsed.incomplete === true) entry.truncated = true;
      }
    }
  }
  return [...byKey.values()];
}
