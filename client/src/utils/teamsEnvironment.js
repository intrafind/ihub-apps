/**
 * Detect a Microsoft Teams host without loading the Teams SDK (~484 KB).
 *
 * Teams opens the tab with `?loginHint=…`/`?userObjectId=…`/`?theme=…`, or
 * with `window.name === 'embedded'`. Those signals only exist on the first
 * URL of the session — in-app navigation drops the query string — so the
 * result is computed once and reused for the lifetime of the page.
 */
let detected;

export function isTeamsEnvironment() {
  if (detected !== undefined) return detected;
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  detected =
    params.has('loginHint') ||
    params.has('userObjectId') ||
    params.has('theme') ||
    params.has('isTeams') ||
    window.name === 'embedded' ||
    window.location.hostname === 'teams.microsoft.com';
  return detected;
}

/** Test hook: forget the cached detection. */
export function resetTeamsEnvironmentDetection() {
  detected = undefined;
}
