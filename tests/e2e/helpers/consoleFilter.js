// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which console errors of a crawled page are the noise of a request that was
 * expected to fail, and which are not.
 *
 * When a request fails, the client logs `API Error: … {…, url: /path}` and a page
 * that cannot do without it may follow with `Error loading …` / `Failed to …`.
 * Those lines are excused only when they belong to an expected failure: the first
 * must name the URL of a request that was expected to fail, and a second line is
 * excused only straight after it. Anything else — a different URL, or a `Failed
 * to …` with no expected request right before it — is a defect to report.
 */

/** `/api/admin/x%2Fy?z` and `/admin/x/y` → `/admin/x/y`. */
const normalize = p => {
  let s = p;
  try {
    s = decodeURIComponent(p);
  } catch {
    /* keep the raw text */
  }
  return s.replace(/^.*?\/api(?=\/)/, '').split('?')[0];
};

/**
 * @param {RegExp[]} ignored console lines that are never a problem
 */
export function createConsoleFilter(ignored = []) {
  const expected = new Set();
  let followUp = false;
  return {
    /** An API request that is expected to fail was answered with an error. */
    expectFailure(pathname) {
      expected.add(normalize(pathname));
    },
    /** True when this console error needs no report. */
    excuses(text) {
      if (ignored.some(re => re.test(text))) return true;
      if (text.startsWith('API Error')) {
        const url = /url: ([^}\s,]+)/.exec(text)?.[1];
        followUp = Boolean(url) && expected.has(normalize(url));
        return followUp;
      }
      const wrapper = followUp && /^(Error loading|Failed to)/.test(text);
      followUp = false;
      return wrapper;
    }
  };
}
