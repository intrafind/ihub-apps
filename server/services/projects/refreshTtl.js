// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How long a project item's content is taken as current (#3536): the refresh
 * TTL of a file downloaded from a website and of a web page's snapshot
 * (#3622).
 *
 * Three levels, the most specific set one wins:
 *
 *  1. the item's `refreshTtl` (item menu),
 *  2. the project's `refreshTtl` (project settings, owners and editors),
 *  3. `platform.projects.refreshTtl` (admin), 86 400 seconds (a day) by default.
 *
 * A value is a number of seconds, or `'never'`: the snapshot is then
 * refreshed only when someone asks ("Refresh now").
 *
 * Only kinds that fetch without anybody's credentials refresh on their own
 * ({@link refreshesOnSchedule}): a picked cloud document needs the picking
 * user's connection, which a background job must not use, so it stays manual.
 *
 * When an outdated snapshot is refreshed is its **refresh mode**, on the same
 * three levels (`refreshMode`, #3622):
 *
 *  - `auto` (the default): the reconciler refreshes it in the background while
 *    the project is used; a project nobody used for
 *    `platform.projects.refreshIdleDays` (14 by default) is refreshed when it
 *    is used again, like `onDemand`;
 *  - `onDemand`: nothing runs in the background; using the project (a chat, a
 *    search, a workflow reading it, opening it) refreshes what is outdated,
 *    and readers get the stored snapshot meanwhile.
 *
 * `never` stays the TTL's: such an item is refreshed only by hand, in any mode.
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

/** The refresh modes (see the module description). */
export const REFRESH_MODES = Object.freeze(['auto', 'onDemand']);

/** The built-in platform default: in the background while the project is used. */
export const DEFAULT_REFRESH_MODE = 'auto';

/** Days without use after which an `auto` project is refreshed only when used. */
export const DEFAULT_REFRESH_IDLE_DAYS = 14;

/** A refresh mode as the API and the stored documents take it. */
export const zRefreshMode = z.enum(REFRESH_MODES);

/**
 * A stored refresh mode, or null when it is absent or not one: the next level
 * then applies.
 *
 * @param {unknown} value
 * @returns {'auto'|'onDemand'|null}
 */
export function normalizeRefreshMode(value) {
  return REFRESH_MODES.includes(value) ? value : null;
}

/**
 * The refresh mode that applies to an item, and where it comes from.
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {{refreshMode?: string}} settings - `projectSettings(platform)`.
 * @returns {{mode: 'auto'|'onDemand', from: 'item'|'project'|'platform'}}
 */
export function effectiveRefreshMode(item, project, settings) {
  const own = normalizeRefreshMode(item?.refreshMode);
  if (own) return { mode: own, from: 'item' };
  const inherited = normalizeRefreshMode(project?.refreshMode);
  if (inherited) return { mode: inherited, from: 'project' };
  return {
    mode: normalizeRefreshMode(settings?.refreshMode) || DEFAULT_REFRESH_MODE,
    from: 'platform'
  };
}

/**
 * Whether nobody used a project for `refreshIdleDays`: no chat turn in it and
 * no change of its items (`lastActivityAt`). 0 days never counts as idle.
 *
 * @param {Object|null} project
 * @param {{refreshIdleDays?: number}} settings
 * @param {number} [now]
 * @returns {boolean}
 */
export function isProjectIdle(project, settings, now = Date.now()) {
  const days = Number(settings?.refreshIdleDays ?? DEFAULT_REFRESH_IDLE_DAYS);
  if (!Number.isFinite(days) || days <= 0) return false;
  for (const value of [project?.lastActivityAt, project?.updatedAt, project?.createdAt]) {
    const at = Date.parse(value || '');
    if (Number.isFinite(at)) return now - at >= days * 24 * 60 * 60 * 1000;
  }
  return false;
}

/**
 * Whether an item's outdated snapshot is refreshed in the background (by the
 * reconciler), rather than when the project is used: mode `auto`, project not
 * idle.
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {Object} settings
 * @param {number} [now]
 * @returns {boolean}
 */
export function refreshesInBackground(item, project, settings, now = Date.now()) {
  return (
    effectiveRefreshMode(item, project, settings).mode === 'auto' &&
    !isProjectIdle(project, settings, now)
  );
}

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
 * user's credentials (`credentials: 'none'`): `web-file` and `url`.
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
 * Whether an item takes a TTL at all: a snapshot refreshed on schedule.
 *
 * @param {{kind?: string}} item
 * @returns {boolean}
 */
export function takesRefreshTtl(item) {
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
 * The refresh schedule of an item as the client shows it: the TTL and the
 * mode with where each comes from, when its source was last checked, when the
 * snapshot is outdated (`outdatedAt`, `expired` once passed), and when the
 * background refresh takes it (`nextAt`; `null` for `never`, and for a
 * snapshot refreshed when the project is used: `background: false`, with
 * `idle` when that is because nobody used the project lately).
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {Object} settings - `projectSettings(platform)`.
 * @param {number} [now]
 * @returns {{ttl: number|'never', from: string, mode: string, modeFrom: string,
 *   scheduled: boolean, background: boolean, idle: boolean, expired: boolean,
 *   checkedAt: string|null, outdatedAt: string|null, nextAt: string|null}|null}
 *   `null` for an item that takes no TTL.
 */
export function refreshScheduleOf(item, project, settings, now = Date.now()) {
  if (!takesRefreshTtl(item)) return null;
  const { ttl, from } = effectiveRefreshTtl(item, project, settings);
  const { mode, from: modeFrom } = effectiveRefreshMode(item, project, settings);
  const idle = mode === 'auto' && isProjectIdle(project, settings, now);
  const background = mode === 'auto' && !idle && ttl !== REFRESH_NEVER;
  const checked = lastCheckedMs(item);
  const outdated = ttl === REFRESH_NEVER || checked === null ? null : checked + ttl * 1000;
  return {
    ttl,
    from,
    mode,
    modeFrom,
    scheduled: true,
    background,
    idle,
    expired: outdated !== null && now >= outdated,
    checkedAt: checked === null ? null : new Date(checked).toISOString(),
    outdatedAt: outdated === null ? null : new Date(outdated).toISOString(),
    nextAt: background && outdated !== null ? new Date(outdated).toISOString() : null
  };
}

/**
 * Whether the reconciler should refresh an item now: an outdated snapshot
 * ({@link isRefreshExpired}) refreshed in the background
 * ({@link refreshesInBackground}). Any other outdated snapshot waits until its
 * project is used (`ProjectIngestService.refreshOnUse`).
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {Object} settings
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRefreshDue(item, project, settings, now = Date.now()) {
  return (
    isRefreshExpired(item, project, settings, now) &&
    refreshesInBackground(item, project, settings, now)
  );
}

/**
 * Whether an item's snapshot is outdated and may be refreshed now: a kind
 * refreshed on schedule, not set to `never`, not being processed, whose last
 * check is older than its TTL. A file that never got a snapshot (its first
 * download failed) counts from its last attempt, so a broken link is retried
 * once per TTL, not on every tick or every use.
 *
 * @param {Object} item
 * @param {Object|null} project
 * @param {Object} settings
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRefreshExpired(item, project, settings, now = Date.now()) {
  // A web page link not converted yet has no snapshot to refresh: the
  // conversion fetches it (`ProjectIngestService.fetchWaiting`).
  if (item?.storage === 'link') return false;
  if (!refreshesOnSchedule(getItemKind(item?.kind))) return false;
  if (item.refreshingAt || !['ready', 'stale', 'failed'].includes(item.status)) return false;
  const { ttl } = effectiveRefreshTtl(item, project, settings);
  if (ttl === REFRESH_NEVER) return false;
  const checked = lastCheckedMs(item) ?? (Date.parse(item.updatedAt || '') || null);
  if (checked === null) return false;
  return now - checked >= ttl * 1000;
}
