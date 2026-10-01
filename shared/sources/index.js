/**
 * Sources — the one contract through which anything that found something for
 * the user (web search, the page reader, provider grounding, iFinder,
 * iAssistant, any tool, MCP server or integration) reports it, and through
 * which the chat shows, cites, stores, shares and acts on it.
 *
 *   normalizeSource(input) → Source              (source.js)
 *   mergeSources(set, frame) → SourceSet          (sourceSet.js)
 *   resolveCitations(markdown, set) → { cited, considered, … }   (citations.js)
 *   sourcesFromGrounding(meta) → SourceFrame      (grounding.js)
 *
 * See `docs/answer-sources.md`.
 *
 * @module shared/sources
 */
export * from './url.js';
export * from './source.js';
export * from './sourceSet.js';
export * from './citations.js';
export * from './grounding.js';
