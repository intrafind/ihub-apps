// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The name of the screen a page shows, for the browser tab.
 *
 * `DocumentTitle` is the only writer of `document.title`. A page that wants
 * its current screen named there ("Check your draft | Admin | iHub") sets the
 * name here, and `DocumentTitle` puts it in front of the title it builds,
 * again whenever the UI configuration, the language or the name changes. A
 * page that wrote `document.title` itself would lose its text to the next of
 * those changes.
 *
 * One page at a time names a screen; the store holds one name.
 *
 * @module shared/utils/screenTitle
 */

let current = '';
const listeners = new Set();

/**
 * @returns {string} The name of the current screen; empty when no page names one.
 */
export function getScreenTitle() {
  return current;
}

/**
 * Names the current screen, or clears the name with an empty value.
 *
 * @param {string|null|undefined} title
 */
export function setScreenTitle(title) {
  const next = typeof title === 'string' ? title.trim() : '';
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

/**
 * For `useSyncExternalStore`.
 *
 * @param {() => void} listener - Called when the name changes.
 * @returns {() => void} Ends the subscription.
 */
export function subscribeScreenTitle(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
