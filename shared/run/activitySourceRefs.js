// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sources of a stored answer's call rows, sent once.
 *
 * A stored answer lists everything it found twice: as the answer's sources
 * (`message.sources.items`, the sources panel) and under each call that found
 * them (`activity.toolActivity.items[].sources`, the activity rows). A row's
 * source is the panel's entry with fewer fields, so the server sends it as a
 * reference — `{ id }` — whenever the panel's entry has the same value in
 * every field a row shows, and the client puts the fields back from the panel
 * when it loads the message. A row source that differs (read in one call, not
 * in another) is sent as it is.
 *
 * @module shared/run/activitySourceRefs
 */

/** The fields of a call row's source (server `runActivity.boundSource`). */
export const ROW_SOURCE_FIELDS = Object.freeze([
  'id',
  'provider',
  'kind',
  'url',
  'title',
  'ref',
  'origin',
  'read',
  'private'
]);

function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => sameValue(a[key], b[key]));
}

function sourcesById(messageSources) {
  const items = Array.isArray(messageSources?.items) ? messageSources.items : [];
  const byId = new Map();
  for (const source of items) {
    if (source && typeof source.id === 'string' && !byId.has(source.id)) {
      byId.set(source.id, source);
    }
  }
  return byId;
}

function isReference(source) {
  return (
    source !== null &&
    typeof source === 'object' &&
    typeof source.id === 'string' &&
    Object.keys(source).length === 1
  );
}

function rowSourceOf(entry) {
  const out = {};
  for (const field of ROW_SOURCE_FIELDS) {
    if (entry[field] !== undefined) out[field] = entry[field];
  }
  return out;
}

function mapItems(activity, fn) {
  const items = activity?.toolActivity?.items;
  if (!Array.isArray(items)) return activity;
  return {
    ...activity,
    toolActivity: {
      ...activity.toolActivity,
      items: items.map(item =>
        item && Array.isArray(item.sources) && item.sources.length > 0
          ? { ...item, sources: item.sources.map(fn) }
          : item
      )
    }
  };
}

/**
 * The activity with each call row's source that the answer's sources already
 * hold replaced by `{ id }`.
 *
 * @param {Object|null|undefined} activity - a stored message's `activity`
 * @param {Object|null|undefined} messageSources - the same message's `sources`
 * @returns {Object|null|undefined} a new activity; the input when there is nothing to replace
 */
export function referenceRowSources(activity, messageSources) {
  const byId = sourcesById(messageSources);
  if (byId.size === 0) return activity;
  return mapItems(activity, source => {
    const entry = source && byId.get(source.id);
    if (!entry || isReference(source)) return source;
    const same = ROW_SOURCE_FIELDS.every(field => sameValue(source[field], entry[field]));
    return same ? { id: source.id } : source;
  });
}

/**
 * The reverse of {@link referenceRowSources}: each `{ id }` row source filled
 * from the answer's sources. A reference with no entry stays as it is.
 *
 * @param {Object|null|undefined} activity
 * @param {Object|null|undefined} messageSources
 * @returns {Object|null|undefined}
 */
export function resolveRowSources(activity, messageSources) {
  const byId = sourcesById(messageSources);
  if (byId.size === 0) return activity;
  return mapItems(activity, source => {
    if (!isReference(source)) return source;
    const entry = byId.get(source.id);
    return entry ? rowSourceOf(entry) : source;
  });
}
