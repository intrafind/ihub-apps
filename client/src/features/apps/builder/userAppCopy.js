// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Copy an existing app" on the personal "New app" page: which apps a person
 * can copy into an app of their own, and what of such an app the copy takes.
 *
 * The apps come from the user API (`GET /api/apps`, the company apps the
 * person may use, and `GET /api/apps?scope=personal`, the personal apps they
 * own or that are shared with them). An app is offered only when a personal
 * app can become it and the person can read its content:
 *
 * - a company app that is a chat app and switched on (a link app or a
 *   website shown inside iHub has no personal form);
 * - a personal app the person may use, sent with its instructions: a reduced
 *   body (switched off, shares suspended), an app retired for the person and
 *   an open offer are left out.
 *
 * The copy takes only the content keys a personal app may hold
 * (`pickUserAppContent`); the source's ID, owner, members, sharing,
 * publishing state and every company-only setting stay behind. What the
 * installation does not allow in an app of this person is removed on create
 * (`limitToAllowed` of `userAppSource.js`), and the server decides.
 *
 * Pure: no React, no request.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, section 11.3.
 *
 * @module features/apps/builder/userAppCopy
 */

import { isUserAppId, pickUserAppContent } from '../../../../../shared/userAppContent.js';

/**
 * The `code` of the error a copy rejects with when the app cannot become a
 * personal app. `useCopySource` (`features/admin/components/app-create/`)
 * reads the same value; it is written out here so this module stays free of
 * React, and a test keeps the two equal.
 */
export const APP_NOT_COPYABLE = 'APP_NOT_COPYABLE';

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether an app of the user API is a personal app (and not a company app).
 *
 * @param {object} app
 * @returns {boolean}
 */
export function isPersonalApp(app) {
  return app?.ownership === 'user' || isUserAppId(app?.id);
}

/**
 * Whether a person can copy an app into an app of their own.
 *
 * @param {object|null|undefined} app - An app as `GET /api/apps` or
 *   `GET /api/apps/{appId}` answers it.
 * @returns {boolean}
 *
 * @example
 * isCopyableAsUserApp({ id: 'faq', type: 'chat', enabled: true }); // → true
 * isCopyableAsUserApp({ id: 'intranet', type: 'redirect' }); // → false
 * isCopyableAsUserApp({ id: 'uap_…', ownership: 'user', name: { en: 'X' } }); // → false (reduced)
 */
export function isCopyableAsUserApp(app) {
  if (!isPlainObject(app) || typeof app.id !== 'string' || app.id === '') return false;
  if (isPersonalApp(app)) {
    // Only the full body carries the instructions; the reduced one has none to copy.
    return (
      isPlainObject(app.system) &&
      app.state !== 'retired' &&
      !app.disabled &&
      app.permissions?.canUse === true
    );
  }
  return (app.type ?? 'chat') === 'chat' && app.enabled !== false;
}

/**
 * The apps of the copy dialog: the company apps first, then the personal
 * ones, each once, and only those {@link isCopyableAsUserApp} accepts.
 *
 * @param {object[]|null|undefined} companyApps - `GET /api/apps`.
 * @param {object[]|null|undefined} personalApps - `GET /api/apps?scope=personal`.
 * @returns {object[]}
 */
export function copyableApps(companyApps, personalApps) {
  const seen = new Set();
  const result = [];
  for (const app of [
    ...(Array.isArray(companyApps) ? companyApps : []),
    ...(Array.isArray(personalApps) ? personalApps : [])
  ]) {
    if (!isCopyableAsUserApp(app) || seen.has(app.id)) continue;
    seen.add(app.id);
    result.push(app);
  }
  return result;
}

/**
 * What a copy starts from: the content a personal app may hold, plus the
 * source's ID (the create screens name the copied app by it; it is never
 * sent). Every language of the texts is kept; `capabilities` is the personal
 * form of what the app uses for this person.
 *
 * @param {object} app - A copyable app as `GET /api/apps/{appId}` answers it.
 * @returns {object} A new object.
 *
 * @example
 * copySourceOf({ id: 'faq', category: 'hr', name: { en: 'FAQ' }, system: { en: '…' },
 *   websearch: { enabled: true }, allowedModels: ['a'] });
 * // → { id: 'faq', name: { en: 'FAQ' }, system: { en: '…' },
 * //     capabilities: { upload: false, webSearch: true, skills: false, integrations: [] } }
 */
export function copySourceOf(app) {
  return { id: app.id, ...pickUserAppContent(app) };
}

/**
 * The error a copy rejects with for an app a personal app cannot become.
 *
 * @param {string} appId
 * @returns {Error} With `code` {@link APP_NOT_COPYABLE}.
 */
export function notCopyableError(appId) {
  const error = new Error(`The app "${appId}" cannot be copied into a personal app`);
  error.code = APP_NOT_COPYABLE;
  return error;
}
