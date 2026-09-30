/**
 * The sources of one answer: everything its producers reported, merged into
 * one list, plus what was searched for.
 *
 *   SourceSet   { items: Source[], queries: string[], supports: Support[] }
 *   SourceFrame { callId?, step?, items: SourceInput[], queries?: string[], supports?: Support[] }
 *
 * A frame is what one producer reported at one moment — the sources of one
 * tool call, one piece of provider grounding, one iAssistant payload. Frames
 * only ever add: {@link mergeSources} folds them in order, the first sighting
 * of a source fixing its position and later ones filling in what it lacks.
 * The server folds a turn's frames into the set it stores with the answer, and
 * the client folds the same frames into the set it shows live, with this same
 * function, so the two are one list by construction.
 *
 * `supports` are Google Search grounding's passages with the sources each one
 * rests on (`{ text, urls }`); they place citation markers in the answer text
 * and are not stored (the markers are in the stored text instead).
 *
 * @module shared/sources/sourceSet
 */
import { mergeSource, normalizeSource } from './source.js';
import { httpUrl } from './url.js';

/** Most sources kept for one answer. */
export const MAX_SOURCES = 100;
/** Most queries kept for one answer. */
export const MAX_QUERIES = 30;
/** Most grounding supports kept for one answer. */
const MAX_SUPPORTS = 200;
const MAX_QUERY_CHARS = 300;
const MAX_SUPPORT_CHARS = 4000;

/** @returns {{items: Array, queries: string[], supports: Array}} */
export function emptySourceSet() {
  return { items: [], queries: [], supports: [] };
}

function queryText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_QUERY_CHARS) : null;
}

function supportOf(value) {
  const passage = typeof value?.text === 'string' ? value.text : '';
  if (!passage.trim() || passage.length > MAX_SUPPORT_CHARS) return null;
  const urls = [...new Set((Array.isArray(value.urls) ? value.urls : []).map(httpUrl))].filter(
    Boolean
  );
  return urls.length ? { text: passage, urls } : null;
}

function isSourceSet(set) {
  return (
    !!set && Array.isArray(set.items) && Array.isArray(set.queries) && Array.isArray(set.supports)
  );
}

/**
 * The set with a frame folded in. Pure: the set passed in is not changed, and
 * a frame that adds nothing returns it as it was.
 *
 * @param {{items?: Array, queries?: string[], supports?: Array}|null} set
 * @param {{items?: Array, queries?: string[], supports?: Array}|null} frame
 * @param {Object} [defaults] - for {@link normalizeSource}
 * @returns {{items: Array, queries: string[], supports: Array}}
 */
export function mergeSources(set, frame, defaults) {
  const base = {
    items: Array.isArray(set?.items) ? set.items : [],
    queries: Array.isArray(set?.queries) ? set.queries : [],
    supports: Array.isArray(set?.supports) ? set.supports : []
  };
  if (!frame || typeof frame !== 'object') return isSourceSet(set) ? set : base;
  let changed = false;

  let items = base.items;
  const incoming = Array.isArray(frame.items) ? frame.items : [];
  if (incoming.length) {
    const index = new Map(items.map((item, position) => [item.id, position]));
    const next = [...items];
    for (const input of incoming) {
      const source = normalizeSource(input, defaults);
      if (!source) continue;
      const position = index.get(source.id);
      if (position === undefined) {
        if (next.length >= MAX_SOURCES) continue;
        index.set(source.id, next.length);
        next.push(source);
        changed = true;
        continue;
      }
      const merged = mergeSource(next[position], source);
      if (JSON.stringify(merged) !== JSON.stringify(next[position])) {
        next[position] = merged;
        changed = true;
      }
    }
    items = next;
  }

  let queries = base.queries;
  for (const value of Array.isArray(frame.queries) ? frame.queries : []) {
    const query = queryText(value);
    if (!query || queries.includes(query) || queries.length >= MAX_QUERIES) continue;
    queries = [...queries, query];
    changed = true;
  }

  let supports = base.supports;
  for (const value of Array.isArray(frame.supports) ? frame.supports : []) {
    const support = supportOf(value);
    if (!support || supports.length >= MAX_SUPPORTS) continue;
    const key = JSON.stringify(support);
    if (supports.some(known => JSON.stringify(known) === key)) continue;
    supports = [...supports, support];
    changed = true;
  }

  if (changed) return { items, queries, supports };
  // Unchanged: the very set passed in, when it was one, so a view keyed on it
  // does not redraw.
  return isSourceSet(set) ? set : base;
}

/**
 * A set as it is stored with an answer or read back from storage: sources and
 * queries, no supports (their markers are in the stored text).
 *
 * @param {Object|null} set
 * @returns {{items: Array, queries: string[]}|null} null when it holds nothing
 */
export function storedSourceSet(set) {
  if (!set || typeof set !== 'object') return null;
  const merged = mergeSources(emptySourceSet(), {
    items: Array.isArray(set.items) ? set.items : [],
    queries: Array.isArray(set.queries) ? set.queries : []
  });
  return merged.items.length || merged.queries.length
    ? { items: merged.items, queries: merged.queries }
    : null;
}

/**
 * A stored set as a share carries it: only the sources that are not private.
 * A source with a `ref` is left out too, whatever it says: its provider
 * fetches it with the owner's permissions, which a viewer does not have. What
 * was searched for is kept with the rest — a share keeps the queries of the
 * turn's activity too — but a set left without sources is dropped whole.
 *
 * @param {Object|null} set - stored set
 * @returns {{items: Array, queries: string[]}|null}
 */
export function shareableSourceSet(set) {
  const stored = storedSourceSet(set);
  if (!stored) return null;
  const items = stored.items.filter(item => item.private !== true && !item.ref);
  return items.length ? { items, queries: stored.queries } : null;
}
