// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Current documents for a reader (#3622): before a chat turn or a workflow
 * step reads its projects, what in them is outdated is refreshed and waited
 * for, at most `platform.projects.refreshWaitSeconds` for the whole read.
 * What is not done by then is read as stored and keeps refreshing; the
 * answer's "About this answer" counts it as outdated.
 *
 * A module of its own, like `projectUse.js`: the knowledge layer and the
 * prompt builder call it without importing the ingest pipeline, which the
 * bootstrap registers (`setReadRefresher`).
 *
 * @module services/projects/readFreshness
 */
import logger from '../../utils/logger.js';

let refresher = null;

/**
 * Register what refreshes a project for a reader (the bootstrap does, with
 * `ProjectIngestService.refreshForRead`).
 *
 * @param {((project: Object, options: Object) => Promise<{project: Object,
 *   total: number, done: number, timedOut: boolean}>)|null} fn
 */
export function setReadRefresher(fn) {
  refresher = typeof fn === 'function' ? fn : null;
}

/** The items of `project` as `latest` stores them now, only those the reader had. */
function withCurrentItems(project, latest) {
  const current = new Map((latest?.items || []).map(item => [item.id, item]));
  return {
    ...project,
    items: (project.items || []).map(item => current.get(item.id) || item)
  };
}

/**
 * Refresh what is outdated in a scope's projects and wait for it, at most the
 * platform's `refreshWaitSeconds` in all. Projects of the local tier only; a
 * project that could not be loaded is passed through.
 *
 * @param {Array<{project: Object, unavailable?: string}>} scope - As
 *   `resolveProjectScope` returns it.
 * @param {Object} options
 * @param {{refreshWaitSeconds: number}} options.settings - `projectSettings(platform)`.
 * @param {(progress: {total: number, done: number}) => void} [options.onProgress] -
 *   The documents being refreshed for this read and how many are done, summed
 *   over the projects; called when the wait starts and as it advances, and
 *   not at all when nothing is outdated.
 * @returns {Promise<{scope: Array<Object>, total: number, done: number, timedOut: boolean}>}
 *   The scope with each project's items as stored when the wait ended.
 */
export async function awaitFreshScope(scope, { settings, onProgress } = {}) {
  const result = { scope, total: 0, done: 0, timedOut: false };
  const waitMs = Math.max(0, Number(settings?.refreshWaitSeconds) || 0) * 1000;
  if (!refresher || !waitMs || !Array.isArray(scope) || !scope.length) return result;
  const deadline = Date.now() + waitMs;
  const counts = new Map();
  const report = () => {
    if (!onProgress) return;
    let total = 0;
    let done = 0;
    for (const entry of counts.values()) {
      total += entry.total;
      done += entry.done;
    }
    if (!total) return;
    try {
      onProgress({ total, done });
    } catch {
      // A progress listener never fails the read.
    }
  };
  const refreshed = await Promise.all(
    scope.map(async (entry, index) => {
      const project = entry?.project;
      if (
        !project?.id ||
        entry.unavailable ||
        (project.tier || 'ihub') !== 'ihub' ||
        !Array.isArray(project.items) ||
        !project.items.length
      ) {
        return entry;
      }
      try {
        const outcome = await refresher(project, {
          deadline,
          onProgress: progress => {
            counts.set(index, progress);
            report();
          }
        });
        if (!outcome?.total) return entry;
        counts.set(index, { total: outcome.total, done: outcome.done });
        return { ...entry, project: withCurrentItems(project, outcome.project) };
      } catch (error) {
        // The reader still gets what is stored.
        logger.warn('Could not refresh a project for a reader', {
          component: 'readFreshness',
          projectId: project.id,
          error: error?.message
        });
        return entry;
      }
    })
  );
  for (const entry of counts.values()) {
    result.total += entry.total;
    result.done += entry.done;
  }
  result.scope = refreshed;
  result.timedOut = result.done < result.total;
  return result;
}
