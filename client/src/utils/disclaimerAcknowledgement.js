// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether this browser has seen the current version of the disclaimer popup
 * (`ui.json → disclaimer`). The browser remembers the version it confirmed, so
 * raising the version under Admin → Disclaimer shows the popup to everybody
 * again. Browsers that confirmed before versions were remembered stored `true`;
 * that counts as the version configured when they next load the page, and a
 * later change asks them again.
 */

export const DISCLAIMER_STORAGE_KEY = 'ihub-disclaimer-acknowledged';

/** What is stored when the disclaimer has no version. */
const UNVERSIONED = 'true';

function versionOf(disclaimer) {
  return String(disclaimer?.version ?? '').trim() || UNVERSIONED;
}

/**
 * @param {Object} disclaimer - `ui.json → disclaimer`
 * @returns {boolean} `true` when nothing has to be shown. A browser that cannot
 *   store the answer is not asked at all, rather than on every page.
 */
export function isDisclaimerAcknowledged(disclaimer) {
  try {
    const stored = window.localStorage.getItem(DISCLAIMER_STORAGE_KEY);
    if (!stored) return false;
    const current = versionOf(disclaimer);
    if (stored === UNVERSIONED && current !== UNVERSIONED) {
      window.localStorage.setItem(DISCLAIMER_STORAGE_KEY, current);
      return true;
    }
    return stored === current;
  } catch {
    return true;
  }
}

/** Remember that this browser confirmed the current version. */
export function acknowledgeDisclaimer(disclaimer) {
  try {
    window.localStorage.setItem(DISCLAIMER_STORAGE_KEY, versionOf(disclaimer));
  } catch {
    /* storage can be blocked: the popup then closes for this visit only */
  }
}

/** The next version after `version`: `"3"` → `"4"`, `"1.0"` → `"1.1"`, anything else → `"2"`. */
export function nextDisclaimerVersion(version) {
  const match = String(version ?? '')
    .trim()
    .match(/^(.*?)(\d+)$/);
  return match ? `${match[1]}${Number(match[2]) + 1}` : '2';
}
