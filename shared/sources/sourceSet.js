// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sources of one answer: everything its producers reported, merged into
 * one list, plus what was searched for.
 *
 *   SourceSet   { items: Source[], queries: string[], supports: Support[], scopes?: Scope[] }
 *   SourceFrame { callId?, step?, items: SourceInput[], queries?: string[], supports?: Support[],
 *                 scopes?: Scope[] }
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
 * `scopes` record where the answer's integrations searched or whom they asked
 * (#3056): `{ integrationId, id, name?, action? }`, one per integration scope
 * (`services/integrations/scopes`) — the iFinder search profile a search ran
 * in, the iAssistant that answered. `name` is a string or a `{ en, de }`
 * object; `action` is `search` ("Searched in …") or `ask` ("Asked …"). The
 * key is present only when the set holds a scope, and a share drops it, as it
 * drops the private sources it describes.
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
/** Most integration scopes recorded for one answer. */
export const MAX_SCOPES = 20;
const MAX_SCOPE_ID_CHARS = 256;
const MAX_SCOPE_NAME_CHARS = 300;
const MAX_SCOPE_NAME_LANGUAGES = 10;
const SCOPE_INTEGRATION = /^[\w.:-]{1,100}$/;
const SCOPE_NAME_LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const SCOPE_ACTIONS = new Set(['search', 'ask']);

/** @returns {{items: Array, queries: string[], supports: Array}} */
export function emptySourceSet() {
  return { items: [], queries: [], supports: [] };
}

/** A search query, whitespace collapsed and cut; null when empty. */
function queryText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_QUERY_CHARS) : null;
}

/** A grounding support `{ text, urls }` with http(s) URLs only, or null. */
function supportOf(value) {
  const passage = typeof value?.text === 'string' ? value.text : '';
  if (!passage.trim() || passage.length > MAX_SUPPORT_CHARS) return null;
  const urls = [...new Set((Array.isArray(value.urls) ? value.urls : []).map(httpUrl))].filter(
    Boolean
  );
  return urls.length ? { text: passage, urls } : null;
}

/** A scope name, whitespace collapsed and cut; null when empty. */
function scopeNameText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_SCOPE_NAME_CHARS) : null;
}

/** A scope's display name: a string, or `{ [language]: string }`; null when none. */
function scopeNameOf(value) {
  if (typeof value === 'string') return scopeNameText(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = {};
  for (const [language, entry] of Object.entries(value)) {
    if (Object.keys(name).length >= MAX_SCOPE_NAME_LANGUAGES) break;
    const localized = SCOPE_NAME_LANGUAGE.test(language) ? scopeNameText(entry) : null;
    if (localized) name[language] = localized;
  }
  return Object.keys(name).length ? name : null;
}

/**
 * An integration scope as a set records it, or null without an integration
 * and a scope id.
 *
 * @param {unknown} value - `{ integrationId, id, name?, action? }`
 * @returns {{integrationId: string, id: string, name?: string|Object, action?: string}|null}
 */
export function normalizeSourceScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { integrationId, id } = value;
  if (typeof integrationId !== 'string' || !SCOPE_INTEGRATION.test(integrationId)) return null;
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > MAX_SCOPE_ID_CHARS ||
    /[\u0000-\u001f\u007f]/.test(id)
  ) {
    return null;
  }
  const scope = { integrationId, id };
  const name = scopeNameOf(value.name);
  if (name) scope.name = name;
  if (SCOPE_ACTIONS.has(value.action)) scope.action = value.action;
  return scope;
}

/** Whether `set` already has the full set shape, so it can be returned unchanged. */
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
    supports: Array.isArray(set?.supports) ? set.supports : [],
    ...(Array.isArray(set?.scopes) && set.scopes.length ? { scopes: set.scopes } : {})
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

  let scopes = base.scopes || [];
  for (const value of Array.isArray(frame.scopes) ? frame.scopes : []) {
    const scope = normalizeSourceScope(value);
    if (!scope) continue;
    const position = scopes.findIndex(
      known => known.integrationId === scope.integrationId && known.id === scope.id
    );
    if (position === -1) {
      if (scopes.length >= MAX_SCOPES) continue;
      scopes = [...scopes, scope];
      changed = true;
    } else if (!scopes[position].name && scope.name) {
      // A later sighting names a scope the first one did not.
      scopes = scopes.map((known, index) =>
        index === position ? { ...known, name: scope.name } : known
      );
      changed = true;
    }
  }

  if (changed) return { items, queries, supports, ...(scopes.length ? { scopes } : {}) };
  // Unchanged: the very set passed in, when it was one, so a view keyed on it
  // does not redraw.
  return isSourceSet(set) ? set : base;
}

/**
 * A set as it is stored with an answer or read back from storage: sources,
 * queries and the integration scopes they were found in, no supports (their
 * markers are in the stored text).
 *
 * @param {Object|null} set
 * @returns {{items: Array, queries: string[], scopes?: Array}|null} null when
 *   it holds no source and no query (scopes alone are no answer's sources)
 */
export function storedSourceSet(set) {
  if (!set || typeof set !== 'object') return null;
  const merged = mergeSources(emptySourceSet(), {
    items: Array.isArray(set.items) ? set.items : [],
    queries: Array.isArray(set.queries) ? set.queries : [],
    scopes: Array.isArray(set.scopes) ? set.scopes : []
  });
  return merged.items.length || merged.queries.length
    ? {
        items: merged.items,
        queries: merged.queries,
        ...(merged.scopes ? { scopes: merged.scopes } : {})
      }
    : null;
}

/**
 * A stored set as a share carries it: only the sources that are not private.
 * A source with a `ref` is left out too, whatever it says: its provider
 * fetches it with the owner's permissions, which a viewer does not have. What
 * was searched for is kept with the rest — a share keeps the queries of the
 * turn's activity too — but a set left without sources is dropped whole. The
 * integration scopes are left out: they name the owner's own search profiles
 * and assistants, like the private sources they describe.
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
