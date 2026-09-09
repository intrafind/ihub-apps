/**
 * Which view the "/" route shows.
 *
 * Admins pick this under Admin → UI Customization → Start Page, stored as
 * `ui.json → startPage.defaultPage`. "start" keeps the personalized start
 * page rendered at "/"; every other choice hands "/" over to an existing
 * route via a redirect, so the URL bar, the sidebar's active item, the
 * document title and bookmarks all agree with what is on screen.
 */

import { sortFavoritesFirst } from './favoriteItems';

export const DEFAULT_HOME_PAGE = 'start';

/** The values `startPage.defaultPage` accepts. Mirrored server-side in routes/admin/ui.js. */
export const HOME_PAGE_CHOICES = ['start', 'apps', 'page', 'app'];

/**
 * Resolve where "/" should send the user.
 *
 * @param {object} uiConfig - The UI configuration (`useUIConfig().uiConfig`).
 * @returns {string|null} The path to redirect to, or `null` to render the start page.
 */
export const resolveHomeRedirect = uiConfig => {
  const startPage = uiConfig?.startPage;
  switch (startPage?.defaultPage || DEFAULT_HOME_PAGE) {
    case 'apps':
      return '/apps';
    case 'page': {
      // A half-configured choice must not strand users on a broken route —
      // fall back to the start page until an admin picks the target.
      const pageId = startPage?.defaultPageId;
      return pageId ? `/pages/${encodeURIComponent(pageId)}` : null;
    }
    case 'app': {
      const appId = startPage?.defaultPageAppId;
      return appId ? `/apps/${encodeURIComponent(appId)}` : null;
    }
    default:
      return null;
  }
};

const isChatApp = app => (app?.type || 'chat') === 'chat';

/**
 * The app whose chat input the start page shows: the admin-configured
 * `startPage.defaultAppId` when the viewer may use it, otherwise the
 * top-ranked chat app (favorites first, then the admin-defined `order`).
 * Only chat apps qualify — an iframe/redirect app has no chat to send to.
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
  const ranked = sortFavoritesFirst(
    list,
    favoriteAppIds,
    (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity)
  );
  return ranked.find(isChatApp) || null;
};

/**
 * Where the sidebar's "New chat" button points. "/" only works while it still
 * shows something with a chat input; once an admin makes the apps browser or a
 * content page the home view, the button goes straight to the default app.
 *
 * @param {object} uiConfig - The UI configuration.
 * @param {Array} apps - Apps the current user may access.
 * @param {string[]} favoriteAppIds - Locally favorited app ids.
 * @returns {string} The path to link to.
 */
export const resolveNewChatPath = (uiConfig, apps, favoriteAppIds) => {
  const redirect = resolveHomeRedirect(uiConfig);
  // No redirect means "/" is the start page; an app home already is a chat.
  if (!redirect || redirect.startsWith('/apps/')) return '/';
  const app = pickDefaultChatApp(apps, favoriteAppIds, uiConfig);
  return app ? `/apps/${encodeURIComponent(app.id)}` : '/apps';
};
