// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The next steps the editor offers after an app was created, and whether
 * their card is shown for an app. Pure, apart from the browser's local
 * storage.
 *
 * The card appears when the editor is opened for a new app and stays, across
 * visits, until the author hides it. Which apps still show it is remembered in
 * this browser.
 *
 * @module features/admin/components/app-editor/nextSteps
 */

/**
 * The steps in the order of the card. `group` names the editor group a step
 * opens (`app-form/editorGroups.js`); a step without one is an action of the
 * page: `test` opens the test chat, `publish` the publish dialog.
 *
 * @type {ReadonlyArray<{id: string, labelKey: string, group?: string}>}
 */
export const NEXT_STEPS = Object.freeze([
  Object.freeze({ id: 'test', labelKey: 'admin.apps.create.done.steps.test' }),
  Object.freeze({
    id: 'inputFields',
    labelKey: 'admin.apps.create.done.steps.inputFields',
    group: 'instructions'
  }),
  Object.freeze({
    id: 'starters',
    labelKey: 'admin.apps.create.done.steps.starters',
    group: 'instructions'
  }),
  Object.freeze({
    id: 'access',
    labelKey: 'admin.apps.create.done.steps.access',
    group: 'access'
  }),
  Object.freeze({ id: 'publish', labelKey: 'admin.apps.create.done.steps.publish' })
]);

const STORAGE_PREFIX = 'ihub.admin.appNextSteps.';
const SHOWN = 'shown';

const storageKey = appId => `${STORAGE_PREFIX}${appId}`;

/**
 * Whether the next-steps card is shown for an app.
 *
 * Local storage can be switched off or full; the card then shows for this
 * visit only, which the caller holds in its own state.
 *
 * @param {string} appId
 * @returns {boolean}
 */
export function nextStepsShown(appId) {
  if (!appId) return false;
  try {
    return window.localStorage.getItem(storageKey(appId)) === SHOWN;
  } catch {
    return false;
  }
}

/**
 * Shows the card for an app that was just created, until the author hides it.
 *
 * @param {string} appId
 */
export function showNextSteps(appId) {
  if (!appId) return;
  try {
    window.localStorage.setItem(storageKey(appId), SHOWN);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/**
 * Hides the card for an app. Nothing is kept about the app afterwards, so an
 * app that is created later under the same ID gets its card again.
 *
 * @param {string} appId
 */
export function hideNextSteps(appId) {
  if (!appId) return;
  try {
    window.localStorage.removeItem(storageKey(appId));
  } catch {
    // Nothing was stored, so there is nothing to forget.
  }
}
