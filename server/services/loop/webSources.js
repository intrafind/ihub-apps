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
 *   - iFinder hits `{ results: [{ title, url?, deepLink }] }` (`iFinder_search`)
 *
 * @module services/loop/webSources
 */
import { isCitationProducingTool } from './toolClassify.js';

/** Most sources one tool call reports; a search is capped at 20 results. */
export const MAX_WEB_SOURCES = 25;
const MAX_TITLE_CHARS = 300;

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
  const title = item.title || item.name || item.heading;
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, MAX_TITLE_CHARS) : null;
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
 * @returns {Array<{url: string, title?: string, read?: boolean, readFailed?: boolean}>}
 *   Sources in result order, deduplicated by URL; empty for any other tool.
 */
export function extractWebSources(toolId, result) {
  if (!isCitationProducingTool(toolId)) return [];
  const parsed = parse(result);
  if (!parsed || typeof parsed !== 'object' || parsed.error) return [];

  const byUrl = new Map();
  const add = (item, read) => {
    if (!item || typeof item !== 'object') return;
    const url = linkOf(item);
    if (!url) return;
    let entry = byUrl.get(url);
    if (!entry) {
      if (byUrl.size >= MAX_WEB_SOURCES) return;
      entry = { url };
      byUrl.set(url, entry);
    }
    const title = titleOf(item);
    if (title && !entry.title) entry.title = title;
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
  } else {
    addAll(parsed.results);
    addAll(parsed.items);
    addAll(parsed.sources);
    // Pages the search went on to fetch: whether each one could be read.
    addAll(parsed.extractedContent, item => item?.contentExtracted === true);
    // A single fetched page.
    if (typeof parsed.url === 'string' && typeof parsed.content === 'string') add(parsed, true);
  }
  return [...byUrl.values()];
}
