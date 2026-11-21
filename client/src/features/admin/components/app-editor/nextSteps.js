// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The next steps the editor offers after an app was created, and whether
 * their card is shown for an app. Pure, apart from the browser's local
 * storage.
 *
 * The card appears when the editor is opened for a new app and stays until
 * the author hides it; that choice is remembered per app in this browser.
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
const HIDDEN = 'hidden';

const storageKey = appId => `${STORAGE_PREFIX}${appId}`;

/** Local storage can be switched off or full; the card then shows for this visit only. */
function read(appId) {
  try {
    return window.localStorage.getItem(storageKey(appId));
  } catch {
    return null;
  }
}

function write(appId, value) {
  try {
    window.localStorage.setItem(storageKey(appId), value);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/**
 * Whether the next-steps card is shown for an app.
 *
 * @param {string} appId
 * @returns {boolean}
 */
export function nextStepsShown(appId) {
  return Boolean(appId) && read(appId) === SHOWN;
}

/**
 * Shows the card for an app that was just created. An author who hid the
 * card for this app keeps it hidden.
 *
 * @param {string} appId
 * @returns {boolean} Whether the card is shown now.
 */
export function showNextSteps(appId) {
  if (!appId || read(appId) === HIDDEN) return false;
  write(appId, SHOWN);
  return true;
}

/**
 * Hides the card for an app, for good.
 *
 * @param {string} appId
 */
export function hideNextSteps(appId) {
  if (appId) write(appId, HIDDEN);
}
