// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Hands the app to the browser as a JSON file named `app-<id>.json`: what the
 * editor holds at this moment, unsaved edits included.
 *
 * @param {object} app - The app as the editor holds it.
 */
export function downloadApp(app) {
  const link = document.createElement('a');
  link.setAttribute(
    'href',
    `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(app, null, 2))}`
  );
  link.setAttribute('download', `app-${app.id}.json`);
  link.click();
}

export default downloadApp;
