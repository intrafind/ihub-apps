/**
 * Which view the "/" route sends users to.
 *
 * Every view has its own route — the start page at `/start`, the apps browser
 * at `/apps`, content pages at `/pages/{id}`, apps at `/apps/{id}` — and "/"
 * is just a pointer at one of them. Admins choose which under Admin → UI
 * Customization → Start Page, stored as `ui.json → startPage.defaultPage`.
 * Because "/" only ever redirects, the URL bar, the sidebar's active item, the
 * document title and bookmarks always agree with what is on screen.
 */

import { rankAppShortcuts, readAppShortcutConfig } from './appShortcuts';

/** The start page — greeting, chat input and featured apps. */
export const START_PAGE_PATH = '/start';

/** The apps browser — the full, searchable list. */
export const APPS_PAGE_PATH = '/apps';

export const DEFAULT_HOME_PAGE = 'start';

/** The values `startPage.defaultPage` accepts. Mirrored server-side in routes/admin/ui.js. */
export const HOME_PAGE_CHOICES = ['start', 'apps', 'page', 'app'];

/**
 * Resolve where "/" should send the user.
 *
 * @param {object} uiConfig - The UI configuration (`useUIConfig().uiConfig`).
 * @returns {string} The path to redirect to; always a real route.
 */
export const resolveHomePath = uiConfig => {
  const startPage = uiConfig?.startPage;
  switch (startPage?.defaultPage || DEFAULT_HOME_PAGE) {
    case 'apps':
      return APPS_PAGE_PATH;
    case 'page': {
      // A half-configured choice must not strand users on a broken route —
      // fall back to the start page until an admin picks the target.
      const pageId = startPage?.defaultPageId;
      return pageId ? `/pages/${encodeURIComponent(pageId)}` : START_PAGE_PATH;
    }
    case 'app': {
      const appId = startPage?.defaultPageAppId;
      return appId ? `/apps/${encodeURIComponent(appId)}` : START_PAGE_PATH;
    }
    default:
      return START_PAGE_PATH;
  }
};

const isChatApp = app => (app?.type || 'chat') === 'chat';

/**
 * The app whose chat input the start page shows: the admin-configured
 * `startPage.defaultAppId` when the viewer may use it, otherwise the
 * top-ranked chat app — favorites first, then the admin's default apps
 * (`startPage.featuredAppIds`), then the app's `order`.
 * Only chat apps qualify — an iframe/redirect app has no chat to send to.
 *
 * The fallback deliberately ignores `startPage.appsMode`: with `recent` the
 * chat input would swap apps every time the user opened a different one.
 *
 * @param {Array} apps - Apps the current user may access.
 * @param {string[]} favoriteAppIds - Locally favorited app ids.
 * @param {object} uiConfig - The UI configuration.
 * @returns {object|null} The chosen app, or `null` when there is no chat app.
 */
export const pickDefaultChatApp = (apps, favoriteAppIds, uiConfig) => {
  const list = Array.isArray(apps) ? apps : [];
  const configuredId = uiConfig?.startPage?.defaultAppId;
  if (configuredId) {
    const found = list.find(app => app.id === configuredId);
    if (found && isChatApp(found)) return found;
  }
  const { featuredAppIds } = readAppShortcutConfig(uiConfig);
  const ranked = rankAppShortcuts(list, {
    favoriteAppIds,
    featuredAppIds,
    mode: 'order'
  });
  return ranked.find(isChatApp) || null;
};
