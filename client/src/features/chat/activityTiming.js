// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The clock of a run activity row, as pure functions of a row and a reading of
 * the monotonic clock (`performance.now()`), so they can be tested without a
 * component and shared between the list and the screen-reader announcer.
 *
 * A progress frame carries the server's stopwatch (`elapsedMs`, since the call
 * began) and the reducer stamps the client clock (`receivedAt`) when it came
 * in. Between frames the stopwatch is the frame's reading plus the time since
 * it arrived. A reconnect therefore cannot make it run wrong by more than the
 * age of the newest frame, and the system clock is never read.
 *
 * @module features/chat/activityTiming
 */
import { PREPARING_GRACE_MS, STALL_AFTER_MS } from './activityConstants.js';

/**
 * The stopwatch of a row or idle line at `now`.
 *
 * @param {{elapsedMs?: number, receivedAt?: number}} anchor - newest frame's reading and arrival
 * @param {number} now - `performance.now()`
 * @param {boolean} [running=true] - false freezes it at the frame's reading
 * @returns {number} milliseconds, never negative
 */
export function elapsedAt(anchor, now, running = true) {
  const base = Math.max(0, Number(anchor?.elapsedMs) || 0);
  if (!running || !Number.isFinite(anchor?.receivedAt)) return base;
  return base + Math.max(0, now - anchor.receivedAt);
}

/**
 * Whether a row that is still preparing has stopped growing: the size has not
 * increased for `STALL_AFTER_MS`. Measured on the server's stopwatch, so it
 * holds whether frames keep arriving with the same size or stop coming.
 *
 * @param {Object} item - a row of `buildToolActivity`
 * @param {number} now - `performance.now()`
 * @returns {boolean}
 */
export function isStalled(item, now) {
  if (item?.status !== 'preparing' || item.ready || !Number.isFinite(item.grewAtMs)) return false;
  return elapsedAt(item, now) - item.grewAtMs >= STALL_AFTER_MS;
}

/**
 * Whether a row may be shown yet. A row whose arguments are still being
 * written is painted only after `PREPARING_GRACE_MS`, so a call that finishes
 * writing in less never flickers through a `preparing` row; a call refused
 * (`dropped`) before that was never painted and is not shown as failed either.
 * Every other row, and every row that has been painted once, shows at once.
 *
 * @param {Object} item - a row of `buildToolActivity`
 * @param {number} now - `performance.now()`
 * @returns {boolean}
 */
export function isPainted(item, now) {
  if (!Number.isFinite(item?.firstReceivedAt)) return true;
  if (item.status === 'preparing') return now - item.firstReceivedAt >= PREPARING_GRACE_MS;
  if (item.errorCode === 'dropped') {
    return (
      Number.isFinite(item.endedReceivedAt) &&
      item.endedReceivedAt - item.firstReceivedAt >= PREPARING_GRACE_MS
    );
  }
  return true;
}

/**
 * Milliseconds until a row that is not painted yet will be, or null when it is
 * painted already or never will be (a refused call).
 *
 * @param {Object} item - a row of `buildToolActivity`
 * @param {number} now - `performance.now()`
 * @returns {number|null}
 */
export function paintsIn(item, now) {
  if (item?.status !== 'preparing' || !Number.isFinite(item.firstReceivedAt)) return null;
  const left = item.firstReceivedAt + PREPARING_GRACE_MS - now;
  return left > 0 ? left : null;
}
