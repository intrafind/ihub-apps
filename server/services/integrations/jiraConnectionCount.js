// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How many users have connected their Atlassian account, for the "n users
 * connected" pill of the installed list.
 *
 * The number lives here, apart from both `JiraService` (which adjusts it when
 * a user connects or disconnects) and the Jira connector (which shows it), so
 * neither has to import the other. Each cluster worker keeps its own copy: the
 * worker that handled a connect or disconnect adjusts it at once, and
 * `refreshJiraConnectionCount()` re-counts the token files at most once per
 * {@link JIRA_CONNECTION_COUNT_REFRESH_MS} so the other workers converge
 * without a disk read per status request.
 */
import { listJiraConnections } from './jiraConfig.js';

export const JIRA_CONNECTION_COUNT_REFRESH_MS = 30 * 1000;

let count = 0;
let lastRefreshAt = -Infinity;
let inFlight = null;

export function getJiraConnectionCount() {
  return count;
}

/** The count a full listing just produced. */
export function setJiraConnectionCount(value, { now = Date.now() } = {}) {
  count = Math.max(0, Number(value) || 0);
  lastRefreshAt = now;
  return count;
}

/** One user connected (+1) or disconnected (-1) on this worker. */
export function adjustJiraConnectionCount(delta) {
  count = Math.max(0, count + delta);
  return count;
}

/**
 * Re-count the token files, at most once per refresh interval unless forced.
 * A listing that fails leaves the count as it was. Resolves to the count.
 *
 * @param {{ force?: boolean, now?: number }} [options]
 * @returns {Promise<number>}
 */
export function refreshJiraConnectionCount({ force = false, now = Date.now() } = {}) {
  if (inFlight) return inFlight;
  if (!force && now - lastRefreshAt < JIRA_CONNECTION_COUNT_REFRESH_MS) {
    return Promise.resolve(count);
  }
  lastRefreshAt = now;
  inFlight = listJiraConnections()
    .then(
      list => setJiraConnectionCount(list.length, { now }),
      () => count
    )
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Test seam: forget the count and the throttle. */
export function resetJiraConnectionCount() {
  count = 0;
  lastRefreshAt = -Infinity;
  inFlight = null;
}
