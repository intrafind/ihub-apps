// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether this document is shown inside a frame of another page. A module of its own so that a
 * test can stand in for the browser's answer.
 *
 * @returns {boolean}
 */
export function isFramed() {
  try {
    return window.self !== window.top;
  } catch {
    // Reading `window.top` can throw in some sandboxed contexts; such a page is framed.
    return true;
  }
}
