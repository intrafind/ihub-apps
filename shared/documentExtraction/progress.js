// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Progress and Stop of a document extraction. A long document takes seconds to minutes, so the
 * extractors report where they are and stop when the caller asks them to.
 *
 * Both are optional arguments of the extractors (`signal`, `onProgress`): the server leaves them
 * out and nothing changes for it. This module has no imports, like the extractors it serves —
 * `shared/` is also loaded by the server and cannot reach into the client. The signal is only
 * ever asked `signal?.aborted`, so anything shaped like an `AbortSignal` will do.
 *
 * What stopping rejects with is an Error named `AbortError` whose message and `code` are both
 * `'aborted'` — what the client's `isAbortError()` recognises (client/src/utils/abortable.js
 * re-exports these three functions).
 *
 * @module shared/documentExtraction/progress
 */

export const createAbortError = () =>
  Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' });

export const isAbortError = error => error?.code === 'aborted' || error?.name === 'AbortError';

/** Throw the abort error if `signal` has fired. */
export const throwIfAborted = signal => {
  if (signal?.aborted) throw createAbortError();
};

/**
 * What an extractor reports while it works on item `current` (counted from 1) of `total`, a page
 * or a slide: the share of the stage done before this item, and which item it is.
 *
 * @param {string} stage - `extract`, `convert` or `render`
 * @param {'page'|'slide'} unit
 * @param {number} current
 * @param {number} total
 */
export const itemProgress = (stage, unit, current, total) => ({
  stage,
  percent: ((current - 1) / total) * 100,
  detail: { unit, current, total }
});

/**
 * Detail changes that do not move the percentage are reported at most this often: a 1,000-page
 * PDF would otherwise tell the page 1,000 times, as fast as it reads.
 */
const MIN_DETAIL_INTERVAL_MS = 100;

const defaultNow = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * Turn what an extractor reports into overall progress.
 *
 * The extractors report `{ stage, percent, detail }`: `percent` is how far *that stage* is (0-100,
 * `null` when it has nothing to measure) and `detail` says what is being worked on
 * (`{ unit: 'page'|'slide', current, total }`). The caller knows the stages of its format and how
 * much of the whole bar each spans (`stages`: name → `[from, to]`, a scale for the bar and not a
 * share of the time). What `onProgress` receives is `{ stage, percent, detail }` with the overall
 * percent: whole numbers, never going down (a stage that starts over, such as the plain text
 * extraction after a failed structured one, waits until it passes the mark reached before), and
 * `null` while the stage has nothing to measure.
 *
 * Reports are held back when they would say nothing new: the same stage, percent and detail are
 * not repeated, and a detail that changes without moving the percentage is passed on at most
 * every 100 ms. At most one report per percent and stage, whatever the number of pages.
 *
 * @param {Function} [onProgress] - Receives the overall progress; without it nothing is reported
 * @param {Object<string, [number, number]>} stages - Span of each stage on the overall bar. A
 *   stage not listed is reported without a percent
 * @param {Object} [options]
 * @param {() => number} [options.now] - Clock in milliseconds (for tests)
 * @returns {(report: {stage: string, percent?: number|null, detail?: object|null}) => void}
 */
export function createProgressReporter(onProgress, stages, { now = defaultNow } = {}) {
  if (typeof onProgress !== 'function') return () => {};

  let highest = 0;
  let last = null;
  let lastAt = 0;

  return ({ stage, percent = null, detail = null }) => {
    const span = stages[stage];
    let overall = null;
    if (span && typeof percent === 'number') {
      const [from, to] = span;
      const local = Math.min(100, Math.max(0, percent));
      overall = Math.max(highest, Math.round(from + ((to - from) * local) / 100));
    }

    const stageChanged = last === null || stage !== last.stage;
    const percentChanged = last === null || overall !== last.percent;
    const detailChanged =
      detail?.unit !== last?.detail?.unit ||
      detail?.current !== last?.detail?.current ||
      detail?.total !== last?.detail?.total;
    if (!stageChanged && !percentChanged && !detailChanged) return;

    const at = now();
    if (!stageChanged && !percentChanged && at - lastAt < MIN_DETAIL_INTERVAL_MS) return;

    if (overall !== null) highest = overall;
    last = { stage, percent: overall, detail };
    lastAt = at;
    onProgress({ stage, percent: overall, ...(detail && { detail: { ...detail } }) });
  };
}
