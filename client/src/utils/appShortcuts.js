/**
 * App shortcuts — the short app lists the start page and the sidebar show.
 *
 * Both places answer the same question ("which handful of apps do we put in
 * front of this user?"), so they share one ranking and one piece of config
 * (`ui.json → startPage`, edited under Admin → UI Customization → Start Page):
 *
 * - `featuredAppIds`    — the admin's default apps, in the order they set.
 * - `appsMode`          — how everything else ranks: `order` (the app's
 *                         `order` field) or `recent` (most recently used).
 * - `appsCount`         — how many the start page grid shows.
 * - `sidebarAppsCount`  — how many the sidebar's Apps section shows.
 *
 * The ranking is always: the user's favorites, then the admin's default apps,
 * then the rest by mode. Favorites stay on top so a user's own picks are never
 * pushed off the list by configuration.
 */

import { getLocalizedContent } from './localizeContent';

/** The values `startPage.appsMode` accepts. Mirrored server-side in routes/admin/ui.js. */
export const APP_SHORTCUT_MODES = ['order', 'recent'];

export const DEFAULT_APP_SHORTCUT_MODE = 'order';

/** Four fills the start page's two-column grid exactly. */
export const DEFAULT_START_PAGE_APPS_COUNT = 4;

/** Five keeps the sidebar's Apps section short enough to scan. */
export const DEFAULT_SIDEBAR_APPS_COUNT = 5;

/** Upper bound for both counts — beyond this neither surface stays scannable. */
export const MAX_APP_SHORTCUTS = 12;

const clampCount = (value, fallback) => {
  // Unset means "use the built-in default" — and `Number(null)` is 0, which
  // would silently hide the list instead. 0 only counts when it is written.
  if (value === undefined || value === null || value === '') return fallback;
  const count = Number(value);
  if (!Number.isFinite(count)) return fallback;
  return Math.min(Math.max(Math.trunc(count), 0), MAX_APP_SHORTCUTS);
};

/**
 * Read the app-shortcut settings out of the UI config, with every field
 * normalized so callers never have to defend against hand-edited values.
 *
 * @param {object} uiConfig - The UI configuration (`useUIConfig().uiConfig`).
 * @returns {{mode: string, featuredAppIds: string[], startPageCount: number, sidebarCount: number}}
 */
export const readAppShortcutConfig = uiConfig => {
  const startPage = uiConfig?.startPage || {};
  const featured = Array.isArray(startPage.featuredAppIds) ? startPage.featuredAppIds : [];
  return {
    mode: APP_SHORTCUT_MODES.includes(startPage.appsMode)
      ? startPage.appsMode
      : DEFAULT_APP_SHORTCUT_MODE,
    // Drop blanks and duplicates so a stray entry cannot claim a slot twice.
    featuredAppIds: [...new Set(featured.filter(id => typeof id === 'string' && id.length > 0))],
    startPageCount: clampCount(startPage.appsCount, DEFAULT_START_PAGE_APPS_COUNT),
    sidebarCount: clampCount(startPage.sidebarAppsCount, DEFAULT_SIDEBAR_APPS_COUNT)
  };
};

/**
 * Rank apps for the start page and the sidebar: favorites first, then the
 * admin's default apps in their configured order, then everything else by
 * `mode` — recently used first for `recent`, otherwise the app's `order`.
 * Ties fall back to the localized name so the list never reshuffles between
 * renders.
 *
 * Returns a new array; the input is left alone.
 *
 * @param {Array<{id: string, order?: number, name?: object}>} apps - Apps the user may access.
 * @param {object} [options]
 * @param {string[]} [options.favoriteAppIds] - Locally favorited app ids.
 * @param {string[]} [options.featuredAppIds] - Admin-configured default apps, in order.
 * @param {string} [options.mode] - `order` (default) or `recent`.
 * @param {string[]} [options.recentAppIds] - Recently used app ids, most recent first.
 * @param {string} [options.currentLanguage] - Language for the name tie-breaker.
 * @returns {Array} The ranked apps.
 */
export const rankAppShortcuts = (apps, options = {}) => {
  const {
    favoriteAppIds = [],
    featuredAppIds = [],
    mode = DEFAULT_APP_SHORTCUT_MODE,
    recentAppIds = [],
    currentLanguage
  } = options;

  const list = Array.isArray(apps) ? apps : [];
  const favorites = new Set(favoriteAppIds || []);
  const featuredRank = new Map((featuredAppIds || []).map((id, index) => [id, index]));
  const recentRank = new Map((recentAppIds || []).map((id, index) => [id, index]));
  const rankRecent = mode === 'recent';

  // 0 = the user's own favorites, 1 = the admin's default apps, 2 = the rest.
  const tier = app => (favorites.has(app.id) ? 0 : featuredRank.has(app.id) ? 1 : 2);
  const rankIn = (map, app) => (map.has(app.id) ? map.get(app.id) : Infinity);
  const nameOf = app => getLocalizedContent(app.name, currentLanguage) || app.id || '';

  return [...list].sort((a, b) => {
    const byTier = tier(a) - tier(b);
    if (byTier !== 0) return byTier;

    // Inside a tier the admin's curated order comes first (it also orders
    // favorites that happen to be default apps), then the chosen mode.
    const featuredA = rankIn(featuredRank, a);
    const featuredB = rankIn(featuredRank, b);
    if (featuredA !== featuredB) return featuredA - featuredB;

    if (rankRecent) {
      const recentA = rankIn(recentRank, a);
      const recentB = rankIn(recentRank, b);
      if (recentA !== recentB) return recentA - recentB;
    }

    const orderA = a.order ?? Infinity;
    const orderB = b.order ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;

    return nameOf(a).localeCompare(nameOf(b));
  });
};
