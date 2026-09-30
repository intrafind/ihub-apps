import { hostOf } from '../../../../../shared/sources/index.js';

/**
 * How a source and an answer's sources read in the chat: the entry under the
 * answer, the site line of a card, the icon it gets.
 *
 * @module features/chat/sources/sourcesView
 */

/**
 * The label of the entry under an answer: what was searched for, else how
 * many sources there are.
 *
 * @param {Function} t
 * @param {{queries?: string[], items?: Object[]}|null} sources
 * @returns {string} "Searched for “…”" | "3 searches" | "5 sources" | "Sources"
 */
export function sourcesLabel(t, sources) {
  const queries = sources?.queries || [];
  if (queries.length === 1) {
    return t('sources.searchedFor', 'Searched for “{{query}}”', { query: queries[0] });
  }
  if (queries.length > 1) return t('sources.searches', { count: queries.length });
  const count = sources?.items?.length || 0;
  return count ? t('sources.sourcesCount', { count }) : t('sources.title', 'Sources');
}

/**
 * Where a source lives, for its card: the site of a web page, the system a
 * document or record comes from.
 *
 * @param {Object} source
 * @returns {string}
 */
export function siteOf(source) {
  if (source?.site) return source.site;
  return source?.url ? hostOf(source.url) : '';
}

/** Lower-case file type of a document, from its type or its file name. */
export function fileTypeOf(source) {
  const type = String(source?.type || '').toLowerCase();
  if (type) return type;
  const match = /\.([a-z0-9]{1,8})$/i.exec(source?.fileName || '');
  return match ? match[1].toLowerCase() : '';
}
