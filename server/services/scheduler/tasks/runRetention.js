// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How many runs of a task are kept, and for how long.
 *
 * Two limits apply to a task's run history, both optional:
 *
 *   - **count** — keep at most N finished runs, newest first;
 *   - **age** — drop finished runs older than D days.
 *
 * The task's own `retention: { maxRuns, maxAgeDays }` and the platform's
 * `maxRunsPerTask` / `runRetentionDays` both apply, and the stricter nonzero
 * value wins: an owner can keep less than the installation allows, never more.
 * `null` (task) and `0` (platform) mean "no limit of its own".
 *
 * A run that has not finished (queued, running, awaiting approval) is never
 * selected and does not count toward the limit. A skipped slot does not count
 * toward the count limit either; only the age limit removes it.
 *
 * @module services/scheduler/tasks/runRetention
 */
import { isFinalRunStatus, isOlderThanDays } from './taskModel.js';

/** Largest value either limit accepts. */
export const MAX_RETENTION_RUNS = 10_000;
export const MAX_RETENTION_DAYS = 3650;

/**
 * The stricter of two limits where 0, null and undefined mean "none".
 *
 * @param {number|null|undefined} a
 * @param {number|null|undefined} b
 * @returns {number} 0 when neither limits.
 */
function stricter(a, b) {
  const values = [a, b].filter(v => Number.isFinite(v) && v > 0);
  return values.length > 0 ? Math.min(...values) : 0;
}

/**
 * The limits in force for a task.
 *
 * @param {Object} task
 * @param {Object} settings - `scheduledTaskSettings()`.
 * @returns {{maxRuns: number, maxAgeDays: number}} 0 means no limit.
 */
export function effectiveRetention(task, settings) {
  return {
    maxRuns: stricter(task?.retention?.maxRuns, settings?.maxRunsPerTask),
    maxAgeDays: stricter(task?.retention?.maxAgeDays, settings?.runRetentionDays)
  };
}

/**
 * Which runs break the limits.
 *
 * @param {Object[]} runs - A task's runs, in any order.
 * @param {{maxRuns: number, maxAgeDays: number}} limits
 * @param {number} [now]
 * @returns {Object[]} The runs to delete.
 */
export function selectRunsToPrune(runs, { maxRuns, maxAgeDays }, now = Date.now()) {
  if (!(maxRuns > 0) && !(maxAgeDays > 0)) return [];
  const newestFirst = (a, b) =>
    String(b.queuedAt || b.id).localeCompare(String(a.queuedAt || a.id));
  const finished = runs.filter(run => isFinalRunStatus(run.status)).sort(newestFirst);
  // Only runs that ran count toward the limit: a skipped slot is a record
  // without a chat, and counting it would push the last real run out.
  const ran = new Set(
    finished
      .filter(run => run.startedAt && run.status !== 'skipped')
      .slice(0, maxRuns > 0 ? maxRuns : 0)
  );
  return finished.filter(run => {
    const counts = run.startedAt && run.status !== 'skipped';
    if (maxRuns > 0 && counts && !ran.has(run)) return true;
    return maxAgeDays > 0 && isOlderThanDays(run.finishedAt || run.queuedAt, maxAgeDays, now);
  });
}

/**
 * Validate the `retention` field of a task.
 *
 * @param {unknown} input - `{ maxRuns, maxAgeDays }`; a missing, null or empty value is "no limit".
 * @returns {{value: {maxRuns: number|null, maxAgeDays: number|null}|null, errors: Array<{field: string, code: string, message: string}>}}
 */
export function parseRetention(input) {
  const errors = [];
  if (input === null || input === undefined) return { value: null, errors };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      value: null,
      errors: [{ field: 'retention', code: 'INVALID', message: 'Retention must be an object' }]
    };
  }
  const read = (key, max) => {
    const raw = input[key];
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      errors.push({
        field: `retention.${key}`,
        code: 'INVALID',
        message: `${key} must be a whole number between 1 and ${max}`
      });
      return null;
    }
    return n;
  };
  const maxRuns = read('maxRuns', MAX_RETENTION_RUNS);
  const maxAgeDays = read('maxAgeDays', MAX_RETENTION_DAYS);
  return { value: maxRuns || maxAgeDays ? { maxRuns, maxAgeDays } : null, errors };
}
