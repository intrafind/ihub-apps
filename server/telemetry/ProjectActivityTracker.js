// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The working set of projects: which projects a chat turn or a knowledge tool
 * used lately, and how much text they stand for.
 *
 * This is what the search-index cache has to hold, so it is the number to size
 * the cache from (#3652). Counts are windowed (5, 15 and 60 minutes) and are
 * the union across the workers of a cluster: the same shared project used on
 * three workers is one project, not three.
 *
 * @module telemetry/ProjectActivityTracker
 */
import { createClusterUnion } from './clusterUnion.js';
import { registerProjectObservers } from './metrics.js';
import { getConfiguredWorkerCount } from './workerCount.js';

/** Windows the working set is reported over, in minutes. */
export const PROJECT_WINDOWS_MINUTES = Object.freeze([5, 15, 60]);

const MAX_WINDOW_MS = Math.max(...PROJECT_WINDOWS_MINUTES) * 60_000;

/** Cluster-bus channel on which workers report their own entries. */
export const PROJECT_ACTIVITY_CHANNEL = 'metrics:projects-active';

/** Characters of a project's usable text, as the ingest pipeline recorded them. */
export function projectTextChars(project) {
  let total = 0;
  for (const item of project?.items || []) {
    if (item?.status !== 'ready' && item?.status !== 'stale') continue;
    const chars = item.text?.chars;
    if (Number.isFinite(chars) && chars > 0) total += chars;
  }
  return total;
}

class ProjectActivityTracker {
  constructor() {
    /** projectId -> {ts, chars} */
    this.entries = new Map();
    this.observersRegistered = false;
    this.union = createClusterUnion({
      channel: PROJECT_ACTIVITY_CHANNEL,
      getLocalEntries: () => this.localEntries(),
      expectedPeers: () => Math.max(0, getConfiguredWorkerCount() - 1)
    });
  }

  /** Note that a project was used. Cheap; safe to call on every turn. */
  recordProjectUse(project) {
    const id = project?.id;
    if (typeof id !== 'string' || !id) return;
    this.entries.set(id, { ts: Date.now(), chars: projectTextChars(project) });
    if (this.entries.size > 10_000) this._prune(Date.now());
  }

  localEntries() {
    this._prune(Date.now());
    return [...this.entries].map(([id, { ts, chars }]) => [id, ts, chars]);
  }

  /**
   * Working set per window, over this process only or the whole cluster.
   *
   * @param {{cluster?: boolean, now?: number}} [options]
   * @returns {Array<{minutes: number, projects: number, chars: number}>}
   */
  getWorkingSet({ cluster = true, now = Date.now() } = {}) {
    const merged = cluster
      ? this.union.entries()
      : new Map(this.localEntries().map(([id, ts, chars]) => [id, { ts, value: chars }]));
    return PROJECT_WINDOWS_MINUTES.map(minutes => {
      const cutoff = now - minutes * 60_000;
      let projects = 0;
      let chars = 0;
      for (const { ts, value } of merged.values()) {
        if (ts < cutoff) continue;
        projects += 1;
        chars += Number.isFinite(value) ? value : 0;
      }
      return { minutes, projects, chars };
    });
  }

  /** Start answering the other workers and register the gauges. Idempotent. */
  start() {
    this.union.start();
    if (!this.observersRegistered) {
      registerProjectObservers({ getWorkingSet: () => this.getWorkingSet() });
      this.observersRegistered = true;
    }
  }

  _prune(now) {
    const cutoff = now - MAX_WINDOW_MS;
    for (const [id, { ts }] of this.entries) {
      if (ts < cutoff) this.entries.delete(id);
    }
  }

  /** Test seam. */
  reset() {
    this.entries.clear();
    this.union.stop();
  }
}

const projectActivityTracker = new ProjectActivityTracker();
export default projectActivityTracker;
