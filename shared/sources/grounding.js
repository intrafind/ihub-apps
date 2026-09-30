/**
 * Provider-run web search (the model's own search, not a tool) as a source
 * frame. The converters normalize each provider onto one `groundingMetadata`
 * shape, streamed piece by piece:
 *
 *  - every provider: `webSearchQueries`;
 *  - Anthropic and OpenAI Responses: `searchResults` (`{ url, title, page_age? }`)
 *    and `citations` (`{ url, title, cited_text? }`, Anthropic's `cited_text`
 *    or an OpenAI `url_citation`);
 *  - Google: `groundingChunks` (`{ web: { uri, title, domain? } }`) and
 *    `webSupports` (`{ text, urls }`, resolved from `groundingSupports`).
 *
 * A search result is a considered page; a citation, and a Google chunk a
 * support rests on, is a cited one. Web pages are public: a share keeps them.
 *
 * @module shared/sources/grounding
 */
import { hostOf, httpUrl } from './url.js';

const WEB = { provider: 'web', kind: 'page', private: false };

/** Google's grounding links point through a redirect; its title is the site. */
function isGroundingRedirect(url) {
  return /(^|\.)vertexaisearch\.cloud\.google\.com$/i.test(hostOf(url));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {Object|null} meta - one piece of a step's grounding metadata
 * @returns {{items: Array, queries: string[], supports: Array}|null} null when it names nothing
 */
export function sourcesFromGrounding(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const items = [];
  const supports = [];
  const queries = list(meta.webSearchQueries).filter(query => typeof query === 'string');

  for (const result of list(meta.searchResults)) {
    if (result?.url) {
      items.push({ ...WEB, url: result.url, title: result.title, publishedDate: result.page_age });
    }
  }
  for (const citation of list(meta.citations)) {
    if (!citation?.url) continue;
    items.push({
      ...WEB,
      url: citation.url,
      title: citation.title,
      passages: citation.cited_text ? [citation.cited_text] : [],
      cited: true
    });
  }
  for (const chunk of list(meta.groundingChunks)) {
    const web = chunk?.web;
    if (!web?.uri) continue;
    // Cited only when a support names it (below): a chunk no passage rests on
    // was retrieved, not cited. A redirect link says nothing about the site;
    // Google names it in the title.
    items.push({
      ...WEB,
      url: web.uri,
      title: web.title,
      site: web.domain || (isGroundingRedirect(web.uri) ? web.title : undefined)
    });
  }
  for (const support of list(meta.webSupports)) {
    const passage = typeof support?.text === 'string' ? support.text : '';
    const urls = list(support?.urls).map(httpUrl).filter(Boolean);
    if (!passage.trim() || !urls.length) continue;
    supports.push({ text: passage, urls });
    for (const url of urls) items.push({ ...WEB, url, cited: true });
  }

  return items.length || queries.length || supports.length ? { items, queries, supports } : null;
}
