// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How long a project item's content is taken as current (#3536): the refresh
 * TTL of a file downloaded from a website, and the cache lifetime of a web
 * page read live.
 *
 * Three levels, the most specific set one wins:
 *
 *  1. the item's `refreshTtl` (item menu),
 *  2. the project's `refreshTtl` (project settings, owners and editors),
 *  3. `platform.projects.refreshTtl` (admin), 86 400 seconds (a day) by default.
 *
 * A value is a number of seconds, or `'never'`: a downloaded file is then
 * refreshed only when someone asks ("Refresh now"), and a web page is kept
 * for {@link NEVER_LINK_CACHE_SECONDS} in memory (a restart reads it again).
 *
 * Only kinds that fetch without anybody's credentials refresh on their own
 * ({@link refreshesOnSchedule}): a picked cloud document needs the picking
 * user's connection, which a background job must not use, so it stays manual.
 *
 * @module services/projects/refreshTtl
 */
import { z } from 'zod';
import { getItemKind } from './kinds/registry.js';

/** The value that turns scheduled refreshes off. */
export const REFRESH_NEVER = 'never';

/**
 * Shortest TTL: the reconciler that refreshes expired files runs every
 * fifteen minutes, so a shorter one would promise what nothing keeps.
 */
export const MIN_REFRESH_TTL_SECONDS = 15 * 60;

/** Longest TTL in seconds (a year); beyond that, `never` says it better. */
export const MAX_REFRESH_TTL_SECONDS = 365 * 24 * 60 * 60;

/** The built-in platform default: a day. */
export const DEFAULT_REFRESH_TTL_SECONDS = 24 * 60 * 60;

/** How long a web page set to `never` stays in the reader's memory. */
export const NEVER_LINK_CACHE_SECONDS = 30 * 24 * 60 * 60;

/** The kind whose cache lifetime follows the TTL although it is read live. */
const LIVE_KIND = 'url';

/** A TTL as the API and the stored documents take it. */
export const zRefreshTtl = z.union([
  z.number().int().min(MIN_REFRESH_TTL_SECONDS).max(MAX_REFRESH_TTL_SECONDS),
  z.literal(REFRESH_NEVER)
]);

/**
 * A stored TTL, or null when it is absent or not one (an older or hand-edited
 * document): the next level then applies.
 *
 * @param {unknown} value
 * @returns {number|'never'|null}
 */
export function normalizeRefreshTtl(value) {
  if (value === REFRESH_NEVER) return REFRESH_NEVER;
  const seconds = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(seconds)) {
    return null;
  }
  return Math.min(MAX_REFRESH_TTL_SECONDS, Math.max(MIN_REFRESH_TTL_SECONDS, Math.floor(seconds)));
}

/**
 * Whether items of a kind are refreshed by the reconciler when their TTL ran
 * out: a stored snapshot (`storage: text`) the kind fetches itself, with no
 * user's credentials (`credentials: 'none'`). Today that is `web-file`.
 *
 * @param {Object|null} kind - A registered kind.
 * @returns {boolean}
 */
export function refreshesOnSchedule(kind) {
  return (
    kind?.storage?.ihub === 'text' &&
    kind.credentials === 'none' &&
    typeof kind.fetch === 'function'
  );
}

/**
 * Whether an item takes a TTL at all: a file refreshed on schedule, or a web
 * page whose cache lifetime the TTL sets.
 *
 * @param {{kind?: string}} item
 * @returns {boolean}
 */
export function takesRefreshTtl(item) {
  if (item?.kind === LIVE_KIND) return true;
  return refreshesOnSchedule(getItemKind(item?.kind));
}

/**
 * The TTL that applies to an item, and where it comes from.
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {{refreshTtl?: number|'never'}} settings - `projectSettings(platform)`.
 * @returns {{ttl: number|'never', from: 'item'|'project'|'platform'}}
 */
export function effectiveRefreshTtl(item, project, settings) {
  const own = normalizeRefreshTtl(item?.refreshTtl);
  if (own !== null) return { ttl: own, from: 'item' };
  const inherited = normalizeRefreshTtl(project?.refreshTtl);
  if (inherited !== null) return { ttl: inherited, from: 'project' };
  return {
    ttl: normalizeRefreshTtl(settings?.refreshTtl) ?? DEFAULT_REFRESH_TTL_SECONDS,
    from: 'platform'
  };
}

/**
 * When the source of an item was last checked: the last refresh (whether it
 * found a change, found none, or failed), else the snapshot.
 *
 * @param {Object} item
 * @returns {number|null} Milliseconds, or null when never.
 */
function lastCheckedMs(item) {
  for (const value of [item?.checkedAt, item?.snapshotAt]) {
    const at = Date.parse(value || '');
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/**
 * The refresh schedule of an item as the client shows it: the TTL, where it
 * comes from, and — for a file refreshed on schedule — when its source was
 * last checked and when it is checked next (`null` for `never`).
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {Object} settings - `projectSettings(platform)`.
 * @returns {{ttl: number|'never', from: string, scheduled: boolean,
 *   checkedAt?: string|null, nextAt?: string|null}|null} `null` for an item
 *   that takes no TTL.
 */
export function refreshScheduleOf(item, project, settings) {
  if (!takesRefreshTtl(item)) return null;
  const { ttl, from } = effectiveRefreshTtl(item, project, settings);
  if (item.kind === LIVE_KIND) return { ttl, from, scheduled: false };
  const checked = lastCheckedMs(item);
  return {
    ttl,
    from,
    scheduled: true,
    checkedAt: checked === null ? null : new Date(checked).toISOString(),
    nextAt:
      ttl === REFRESH_NEVER || checked === null
        ? null
        : new Date(checked + ttl * 1000).toISOString()
  };
}

/**
 * Whether the reconciler should refresh an item now: a file refreshed on
 * schedule, not set to `never`, not being processed, whose last check is
 * older than its TTL. A file that never got a snapshot (its first download
 * failed) counts from its last attempt, so a broken link is retried once per
 * TTL, not on every tick.
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {Object} settings
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRefreshDue(item, project, settings, now = Date.now()) {
  if (!refreshesOnSchedule(getItemKind(item?.kind))) return false;
  if (item.refreshingAt || !['ready', 'stale', 'failed'].includes(item.status)) return false;
  const { ttl } = effectiveRefreshTtl(item, project, settings);
  if (ttl === REFRESH_NEVER) return false;
  const checked = lastCheckedMs(item) ?? (Date.parse(item.updatedAt || '') || null);
  if (checked === null) return false;
  return now - checked >= ttl * 1000;
}

/**
 * How long a web page item's text is cached once read, in seconds.
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {Object} settings
 * @returns {number}
 */
export function linkCacheSeconds(item, project, settings) {
  const { ttl } = effectiveRefreshTtl(item, project, settings);
  return ttl === REFRESH_NEVER ? NEVER_LINK_CACHE_SECONDS : ttl;
}
