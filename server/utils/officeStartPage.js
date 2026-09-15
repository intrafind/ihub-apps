/**
 * The Outlook add-in's start page settings — `platform.json →
 * officeIntegration.startPage`.
 *
 * The task pane mirrors the web app's start page (`ui.json → startPage`, see
 * routes/admin/ui.js): after signing in, users land either on a start page —
 * greeting, the default app's chat input with the open email as context, a
 * handful of app shortcuts — or on the plain apps list. The add-in keeps its
 * own copy of these settings because the two surfaces are used differently
 * (an email-triage app is a fine default in Outlook and a poor one on the web)
 * and because the pane reads its configuration from the public add-in config
 * endpoint, not from ui.json.
 *
 * - `defaultPage`    — `start` (the start page, the default) or `apps` (the
 *                      apps list, the pane's pre-start-page behaviour).
 * - `defaultAppId`   — the app whose chat input the start page shows; unset
 *                      means the top-ranked chat app the user may access.
 * - `featuredAppIds` — the admin's default apps, listed on the start page in
 *                      this order right after each user's favorites.
 *
 * Two readers, two strictness levels: the public config endpoint *sanitizes*
 * (a hand-edited platform.json must never break the pane), the admin endpoint
 * *validates* (a bad save is reported, not silently repaired). Mirrored on the
 * client in features/office/utilities/officeStartPage.js.
 */

import { APP_ID_PATTERN, APP_ID_MAX_LENGTH } from '../../shared/validationPatterns.js';

/** The values `officeIntegration.startPage.defaultPage` accepts. */
export const OFFICE_START_PAGE_CHOICES = ['start', 'apps'];

export const DEFAULT_OFFICE_START_PAGE = 'start';

/** Nobody curates more default apps than this; the pane shows a handful anyway. */
export const MAX_OFFICE_FEATURED_APPS = 50;

const isAppId = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= APP_ID_MAX_LENGTH &&
  APP_ID_PATTERN.test(value);

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The settings as the task pane may rely on them: every field present and
 * well-formed, whatever platform.json holds. Never throws.
 *
 * @param {unknown} value - `officeIntegration.startPage` as stored.
 * @returns {{ defaultPage: string, defaultAppId?: string, featuredAppIds: string[] }}
 */
export function sanitizeOfficeStartPage(value) {
  const raw = isPlainObject(value) ? value : {};
  const featured = Array.isArray(raw.featuredAppIds) ? raw.featuredAppIds.filter(isAppId) : [];
  const out = {
    defaultPage: OFFICE_START_PAGE_CHOICES.includes(raw.defaultPage)
      ? raw.defaultPage
      : DEFAULT_OFFICE_START_PAGE,
    // Drop duplicates so a stray entry cannot claim a slot twice.
    featuredAppIds: [...new Set(featured)].slice(0, MAX_OFFICE_FEATURED_APPS)
  };
  if (isAppId(raw.defaultAppId)) out.defaultAppId = raw.defaultAppId;
  return out;
}

/**
 * Check a start-page object an admin is saving. App ids end up in API calls
 * made by the pane, so they get the same treatment as every other app id in
 * the configuration.
 *
 * @param {unknown} value - The `startPage` field of the request body.
 * @returns {{ value: object } | { error: string }} The normalized object to
 *   store — only the known fields, unset ones filled with their defaults — or
 *   the reason the input was rejected.
 */
export function validateOfficeStartPage(value) {
  if (!isPlainObject(value)) {
    return { error: 'startPage must be an object like { defaultPage: "start" }' };
  }
  const { defaultPage, defaultAppId, featuredAppIds } = value;
  const out = { defaultPage: DEFAULT_OFFICE_START_PAGE, featuredAppIds: [] };

  if (defaultPage !== undefined && defaultPage !== null && defaultPage !== '') {
    if (!OFFICE_START_PAGE_CHOICES.includes(defaultPage)) {
      return {
        error: `startPage.defaultPage must be one of: ${OFFICE_START_PAGE_CHOICES.join(', ')}`
      };
    }
    out.defaultPage = defaultPage;
  }

  if (defaultAppId !== undefined && defaultAppId !== null && defaultAppId !== '') {
    if (!isAppId(defaultAppId)) {
      return { error: 'startPage.defaultAppId must be a valid app id' };
    }
    out.defaultAppId = defaultAppId;
  }

  if (featuredAppIds !== undefined && featuredAppIds !== null) {
    if (!Array.isArray(featuredAppIds)) {
      return { error: 'startPage.featuredAppIds must be an array of app ids' };
    }
    if (featuredAppIds.length > MAX_OFFICE_FEATURED_APPS) {
      return {
        error: `startPage.featuredAppIds must not hold more than ${MAX_OFFICE_FEATURED_APPS} ids`
      };
    }
    if (!featuredAppIds.every(isAppId)) {
      return { error: 'startPage.featuredAppIds must only contain valid app ids' };
    }
    if (new Set(featuredAppIds).size !== featuredAppIds.length) {
      return { error: 'startPage.featuredAppIds must not contain duplicates' };
    }
    out.featuredAppIds = [...featuredAppIds];
  }

  return { value: out };
}
