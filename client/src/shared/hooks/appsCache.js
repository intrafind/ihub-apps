// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { fetchApps, fetchUserApps } from '../../api';

/**
 * The shared store behind `useApps`. The sidebar, the start page and the apps
 * browser all need the apps list. One module-level store shares a single
 * in-flight request per user, keeps the result for a short while, and tells
 * every mounted consumer when fresh data arrives — so the sidebar (mounted
 * once in Layout) picks up a refetch triggered by a page that mounted later.
 *
 * It lives apart from the hook so that a page that only changes apps (the
 * personal app editor) can drop the cache without loading the sign-in
 * context the hook needs.
 *
 * @module shared/hooks/appsCache
 */

const CACHE_TTL_MS = 30_000;
let cache = null; // { key, promise, apps, at }
const listeners = new Set();

/** Whether the store holds a fresh list for this key. */
export const freshHit = key =>
  !!(cache && cache.key === key && cache.apps && Date.now() - cache.at < CACHE_TTL_MS);

/** The list the store holds; read it only after {@link freshHit}. */
export const cachedApps = () => cache?.apps ?? null;

const notify = () => listeners.forEach(listener => listener());

/**
 * Registers a consumer that is called whenever the store changes.
 *
 * @param {() => void} listener
 * @returns {() => void} Removes the listener again.
 */
export function subscribeApps(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The marker a cache key carries when the list also holds personal apps. */
export const PERSONAL_KEY_SUFFIX = '|personal';

/**
 * The personal apps of the viewer, for the merged list. A failure here must
 * not take the admin apps away, so it reads as "none".
 */
const loadPersonalApps = () =>
  fetchUserApps({ scope: 'personal' })
    .then(items => (Array.isArray(items) ? items : []))
    .catch(error => {
      console.error('Error loading personal apps:', error);
      return [];
    });

/**
 * One list of admin apps and personal apps. A personal app never has the ID
 * of an admin app; should the server ever send both, the admin app wins.
 */
function mergeApps(adminApps, personalApps) {
  if (personalApps.length === 0) return adminApps;
  const known = new Set(adminApps.map(app => app?.id));
  return [...adminApps, ...personalApps.filter(app => app?.id && !known.has(app.id))];
}

/**
 * The apps for a viewer key: from the store while fresh, else one request
 * shared by every consumer asking at the same time.
 *
 * @param {string} key - The viewer key; ends in {@link PERSONAL_KEY_SUFFIX}
 *   when the personal apps belong in the list.
 * @returns {Promise<object[]>}
 */
export function loadApps(key) {
  if (freshHit(key)) return Promise.resolve(cache.apps);
  if (cache && cache.key === key && cache.promise) return cache.promise;
  const previous = cache && cache.key === key ? cache : null;
  const withPersonal = key.endsWith(PERSONAL_KEY_SUFFIX);
  const promise = Promise.all([fetchApps(), withPersonal ? loadPersonalApps() : []])
    .then(([data, personal]) => {
      const apps = mergeApps(Array.isArray(data) ? data : [], personal);
      cache = { key, apps, at: Date.now(), promise: null };
      notify();
      return apps;
    })
    .catch(error => {
      if (cache && cache.promise === promise) cache = previous;
      throw error;
    });
  cache = { key, promise, apps: previous?.apps ?? null, at: previous?.at ?? 0 };
  return promise;
}

/** Drop the shared apps cache and make every mounted consumer refetch. */
export function invalidateAppsCache() {
  cache = null;
  notify();
}
