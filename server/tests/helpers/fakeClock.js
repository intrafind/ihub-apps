// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A clock a test moves by hand, for code that takes its time source as a
 * parameter (`{ now, setTimer, clearTimer }` or a `clock` object): a lease that
 * expires, a due time, a wall-clock limit, a slow model stream
 * (`turn.slow` in `helpers/scriptedModel.js`).
 *
 * ```js
 * const clock = createFakeClock();
 * const lease = new Lease({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
 * clock.advance(15_000); // fires every timer that is due, in order
 * ```
 *
 * The order is fixed: timers fire by due time, and timers due at the same time
 * fire in the order they were set. A timer set by a firing timer fires in the
 * same `advance` when it falls inside it.
 *
 * Code that calls the global `setTimeout` or `Date.now` directly cannot take
 * this clock. Tests of such code use the fake timers of their runner
 * (`mock.timers` in node:test, `jest.useFakeTimers()` in jest). See
 * docs/run-testing.md.
 *
 * @module tests/helpers/fakeClock
 */

/** 2026-01-05T08:00:00.000Z, a Monday morning: no date arithmetic near a boundary by accident. */
export const FAKE_CLOCK_START = Date.UTC(2026, 0, 5, 8, 0, 0);

/**
 * @param {Object} [options]
 * @param {number|Date} [options.start=FAKE_CLOCK_START] - The time the clock starts at.
 * @returns {Object} The clock; every method is bound, so it can be handed over one by one.
 */
export function createFakeClock({ start = FAKE_CLOCK_START } = {}) {
  let current = start instanceof Date ? start.getTime() : start;
  let sequence = 0;
  /** @type {Map<number, {id: number, due: number, fn: Function, every: number|null}>} */
  const timers = new Map();

  const nextDue = limit => {
    let first = null;
    for (const timer of timers.values()) {
      if (timer.due > limit) continue;
      if (!first || timer.due < first.due || (timer.due === first.due && timer.id < first.id)) {
        first = timer;
      }
    }
    return first;
  };

  const add = (fn, ms, every) => {
    if (typeof fn !== 'function') throw new TypeError('a timer needs a function');
    const delay = Math.max(0, Number(ms) || 0);
    const id = ++sequence;
    timers.set(id, { id, due: current + delay, fn, every });
    return id;
  };

  const fire = timer => {
    current = Math.max(current, timer.due);
    if (timer.every === null) timers.delete(timer.id);
    // An interval of 0 would never let `advance` finish; it fires once per millisecond.
    else timer.due = current + Math.max(1, timer.every);
    return timer.fn();
  };

  const clock = {
    /** The current time in milliseconds since the epoch, like `Date.now()`. */
    now: () => current,

    /** The current time as a `Date`. */
    date: () => new Date(current),

    /** The current time as an ISO string. */
    iso: () => new Date(current).toISOString(),

    /**
     * Like `setTimeout`: run `fn` once, `ms` from now.
     *
     * @param {Function} fn
     * @param {number} [ms=0]
     * @returns {number} The id for `clearTimer`.
     */
    setTimer: (fn, ms = 0) => add(fn, ms, null),

    /**
     * Like `setInterval`: run `fn` every `ms`.
     *
     * @param {Function} fn
     * @param {number} ms
     * @returns {number} The id for `clearTimer`.
     */
    setRepeatingTimer: (fn, ms) => add(fn, ms, Math.max(0, Number(ms) || 0)),

    /** Like `clearTimeout` and `clearInterval`. An unknown id is ignored. */
    clearTimer: id => {
      timers.delete(id);
    },

    /** How many timers are waiting. */
    pending: () => timers.size,

    /** When the next timer is due, or null. */
    nextDueAt: () => nextDue(Infinity)?.due ?? null,

    /**
     * Move the clock forward and fire every timer that becomes due, in order.
     * The callbacks run synchronously; what they started with a promise has not
     * continued when this returns. Use `advanceAsync` when the code under test
     * awaits between timers.
     *
     * @param {number} ms
     * @returns {number} How many timers fired.
     */
    advance: ms => {
      const target = current + Math.max(0, Number(ms) || 0);
      let fired = 0;
      for (let timer = nextDue(target); timer; timer = nextDue(target)) {
        fire(timer);
        fired++;
      }
      current = target;
      return fired;
    },

    /**
     * Like `advance`, but lets pending promise continuations run after each
     * timer, so a chain of "timer fires, code awaits, code sets the next timer"
     * plays out inside one call.
     *
     * @param {number} ms
     * @returns {Promise<number>} How many timers fired.
     */
    advanceAsync: async ms => {
      const target = current + Math.max(0, Number(ms) || 0);
      let fired = 0;
      await settle();
      for (let timer = nextDue(target); timer; timer = nextDue(target)) {
        await fire(timer);
        fired++;
        await settle();
      }
      current = target;
      return fired;
    },

    /**
     * Fire the timers that are due now, without moving the clock.
     *
     * @returns {number} How many timers fired.
     */
    runDue: () => clock.advance(0),

    /**
     * Jump to a point in time without firing anything in between, like a
     * machine that slept. Timers that became due fire on the next `advance` or
     * `runDue`.
     *
     * @param {number|Date} time
     */
    jumpTo: time => {
      const target = time instanceof Date ? time.getTime() : time;
      if (target < current) throw new RangeError('a fake clock does not go back');
      current = target;
    }
  };
  return clock;
}

/**
 * Let promise continuations that are ready run. Not a sleep: it waits for the
 * microtask queue and one turn of the event loop, never for a duration.
 */
function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

export default createFakeClock;
