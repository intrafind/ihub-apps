/**
 * The Outlook add-in's start page — where the task pane lands after sign-in.
 *
 * Mirrors the web app's start page (utils/homePage.js, utils/appShortcuts.js)
 * with the add-in's own settings, `platform.json → officeIntegration.startPage`,
 * which reach the pane through the public add-in config endpoint
 * (`useOfficeConfig().startPage`) and are edited under Admin → Office
 * Integration → Start Page:
 *
 * - `defaultPage`    — `start` (the start page, the default) or `apps` (the
 *                      apps list the pane used to open on).
 * - `defaultAppId`   — the app whose chat input the start page shows; unset
 *                      means the top-ranked chat app the user may access.
 * - `featuredAppIds` — the admin's default apps, listed right after each
 *                      user's own favorites.
 *
 * Every view keeps its own route inside the pane's memory router — the start
 * page at `/start`, the apps list at `/select`, the chat at `/chat` — and the
 * setting only decides which one "home" is: after sign-in, and wherever a back
 * button leads out of a chat. Mirrored server-side in utils/officeStartPage.js,
 * which sanitizes what the pane receives; the normalization here is the last
 * line of defence for a config that bypassed it.
 */

import { pickDefaultChatApp } from '../../../utils/homePage';
import { rankAppShortcuts } from '../../../utils/appShortcuts';

/** The start page — greeting, the default app's chat input, app shortcuts. */
export const OFFICE_START_PAGE_PATH = '/start';

/** The apps list — every app the user may open, with search and favorites. */
export const OFFICE_APPS_PAGE_PATH = '/select';

/** The chat with the selected app. */
export const OFFICE_CHAT_PATH = '/chat';

/** The values `officeIntegration.startPage.defaultPage` accepts. */
export const OFFICE_START_PAGE_CHOICES = ['start', 'apps'];

export const DEFAULT_OFFICE_START_PAGE = 'start';

/**
 * How many app shortcuts the start page lists. Four rows still fit under the
 * chat input on a 600 px-tall pane; the "All apps" link covers the rest.
 */
export const OFFICE_START_PAGE_APPS_COUNT = 4;

const isId = value => typeof value === 'string' && value.length > 0;

/**
 * Read the start-page settings out of the add-in config, every field
 * normalized so callers never have to defend against odd values.
 *
 * @param {object} officeConfig - The add-in config (`useOfficeConfig()`).
 * @returns {{ defaultPage: string, defaultAppId: string|null, featuredAppIds: string[] }}
 */
export const readOfficeStartPageConfig = officeConfig => {
  const raw = officeConfig?.startPage;
  const startPage = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const featured = Array.isArray(startPage.featuredAppIds)
    ? startPage.featuredAppIds.filter(isId)
    : [];
  return {
    defaultPage: OFFICE_START_PAGE_CHOICES.includes(startPage.defaultPage)
      ? startPage.defaultPage
      : DEFAULT_OFFICE_START_PAGE,
    defaultAppId: isId(startPage.defaultAppId) ? startPage.defaultAppId : null,
    // Drop duplicates so a stray entry cannot claim a slot twice.
    featuredAppIds: [...new Set(featured)]
  };
};

/**
 * Where the pane goes once the user is signed in and no app is open.
 *
 * @param {object} officeConfig - The add-in config.
 * @returns {string} `/start` or `/select`; always a real route.
 */
export const resolveOfficeHomePath = officeConfig =>
  readOfficeStartPageConfig(officeConfig).defaultPage === 'apps'
    ? OFFICE_APPS_PAGE_PATH
    : OFFICE_START_PAGE_PATH;

/**
 * The app whose chat input the start page shows — the same rule as the web
 * start page: the admin-configured app when the viewer may use it, otherwise
 * the top-ranked chat app (favorites first, then the default apps, then the
 * app's `order`). Only chat apps qualify.
 *
 * @param {Array} apps - Apps the current user may access.
 * @param {string[]} favoriteAppIds - The user's favorites in this pane.
 * @param {object} officeConfig - The add-in config.
 * @returns {object|null} The chosen app, or `null` when there is no chat app.
 */
export const pickOfficeDefaultApp = (apps, favoriteAppIds, officeConfig) => {
  const { defaultAppId, featuredAppIds } = readOfficeStartPageConfig(officeConfig);
  return pickDefaultChatApp(apps, favoriteAppIds, {
    startPage: { defaultAppId: defaultAppId || undefined, featuredAppIds }
  });
};

/**
 * Rank apps for the start page's shortcut list: favorites, then the admin's
 * default apps in their configured order, then the rest by `order`. The pane
 * does not track recently used apps, so there is no `recent` mode here.
 *
 * @param {Array} apps - Apps the current user may access.
 * @param {object} [options]
 * @param {string[]} [options.favoriteAppIds] - The user's favorites in this pane.
 * @param {object} [options.officeConfig] - The add-in config.
 * @param {string} [options.language] - Language for the name tie-breaker.
 * @returns {Array} The ranked apps (a new array).
 */
export const rankOfficeAppShortcuts = (
  apps,
  { favoriteAppIds = [], officeConfig, language } = {}
) => {
  const { featuredAppIds } = readOfficeStartPageConfig(officeConfig);
  return rankAppShortcuts(apps, {
    favoriteAppIds,
    featuredAppIds,
    mode: 'order',
    currentLanguage: language
  });
};
