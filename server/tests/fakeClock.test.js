// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Self-test of `helpers/fakeClock.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock, FAKE_CLOCK_START } from './helpers/fakeClock.js';

test('the clock starts at a fixed time and only moves when told', () => {
  const clock = createFakeClock();
  assert.equal(clock.now(), FAKE_CLOCK_START);
  assert.equal(clock.iso(), '2026-01-05T08:00:00.000Z');
  assert.equal(clock.date().getTime(), FAKE_CLOCK_START);
  clock.advance(1500);
  assert.equal(clock.now(), FAKE_CLOCK_START + 1500);
  assert.equal(
    createFakeClock({ start: new Date('2030-01-01T00:00:00Z') })
      .iso()
      .slice(0, 4),
    '2030'
  );
});

test('timers fire by due time, and in the order they were set when due together', () => {
  const clock = createFakeClock();
  const fired = [];
  clock.setTimer(() => fired.push('b@200'), 200);
  clock.setTimer(() => fired.push('a@100'), 100);
  clock.setTimer(() => fired.push('c@200'), 200);
  clock.setTimer(() => fired.push('d@300'), 300);
  assert.equal(clock.nextDueAt(), FAKE_CLOCK_START + 100);
  assert.equal(clock.advance(250), 3);
  assert.deepEqual(fired, ['a@100', 'b@200', 'c@200']);
  assert.equal(clock.pending(), 1);
  assert.equal(clock.advance(50), 1);
  assert.deepEqual(fired, ['a@100', 'b@200', 'c@200', 'd@300']);
  assert.equal(clock.nextDueAt(), null);
});

test('a timer sees the time it was due at, not the end of the advance', () => {
  const clock = createFakeClock();
  const seen = [];
  clock.setTimer(() => seen.push(clock.now() - FAKE_CLOCK_START), 100);
  clock.setTimer(() => seen.push(clock.now() - FAKE_CLOCK_START), 400);
  clock.advance(1000);
  assert.deepEqual(seen, [100, 400]);
  assert.equal(clock.now(), FAKE_CLOCK_START + 1000);
});

test('a timer set by a firing timer fires in the same advance when it is due inside it', () => {
  const clock = createFakeClock();
  const fired = [];
  clock.setTimer(() => {
    fired.push('first');
    clock.setTimer(() => fired.push('chained'), 50);
    clock.setTimer(() => fired.push('too late'), 5000);
  }, 100);
  clock.advance(200);
  assert.deepEqual(fired, ['first', 'chained']);
  assert.equal(clock.pending(), 1);
});

test('a cleared timer never fires; clearing an unknown id is harmless', () => {
  const clock = createFakeClock();
  const fired = [];
  const id = clock.setTimer(() => fired.push('cleared'), 10);
  clock.setTimer(() => fired.push('kept'), 10);
  clock.clearTimer(id);
  clock.clearTimer(9999);
  clock.advance(10);
  assert.deepEqual(fired, ['kept']);
});

test('a repeating timer fires once per interval until it is cleared', () => {
  const clock = createFakeClock();
  let ticks = 0;
  const id = clock.setRepeatingTimer(() => ticks++, 1000);
  clock.advance(3500);
  assert.equal(ticks, 3);
  clock.clearTimer(id);
  clock.advance(10_000);
  assert.equal(ticks, 3);
});

test('runDue fires what is due and leaves the time alone; jumpTo fires nothing', () => {
  const clock = createFakeClock();
  const fired = [];
  clock.setTimer(() => fired.push('now'), 0);
  clock.setTimer(() => fired.push('later'), 60_000);
  assert.equal(clock.runDue(), 1);
  assert.equal(clock.now(), FAKE_CLOCK_START);
  clock.jumpTo(FAKE_CLOCK_START + 3_600_000);
  assert.deepEqual(fired, ['now']);
  assert.equal(clock.runDue(), 1);
  assert.deepEqual(fired, ['now', 'later']);
  assert.throws(() => clock.jumpTo(FAKE_CLOCK_START), RangeError);
});

test('advanceAsync lets awaiting code set its next timer between two timers', async () => {
  const clock = createFakeClock();
  const onClock = ms => new Promise(resolve => clock.setTimer(resolve, ms));
  const steps = [];
  const work = (async () => {
    for (let i = 1; i <= 3; i++) {
      await onClock(60_000);
      steps.push(clock.now() - FAKE_CLOCK_START);
    }
  })();
  // The synchronous advance fires the first timer only: the loop has not continued yet.
  clock.advance(180_000);
  assert.deepEqual(steps, []);
  assert.equal(await clock.advanceAsync(180_000), 2);
  await work;
  assert.deepEqual(steps, [180_000, 240_000, 300_000]);
});

test('advanceAsync does not wait for an async callback that waits on a later timer', async () => {
  const clock = createFakeClock();
  const onClock = ms => new Promise(resolve => clock.setTimer(resolve, ms));
  const steps = [];
  // A tick that renews a lease: it fires on a timer and then waits on the clock twice more.
  clock.setTimer(async () => {
    steps.push(`tick@${clock.now() - FAKE_CLOCK_START}`);
    await onClock(100);
    steps.push(`first wait over@${clock.now() - FAKE_CLOCK_START}`);
    await onClock(250);
    steps.push(`second wait over@${clock.now() - FAKE_CLOCK_START}`);
    await onClock(5000);
    steps.push('outside this advance');
  }, 100);
  // The callback's own timers are among the ones this call fires: tick, 100 and 250.
  assert.equal(await clock.advanceAsync(1000), 3);
  assert.deepEqual(steps, ['tick@100', 'first wait over@200', 'second wait over@450']);
  assert.equal(clock.now(), FAKE_CLOCK_START + 1000);
  assert.equal(clock.pending(), 1, 'the wait that is due after the advance is still pending');
  assert.equal(await clock.advanceAsync(5000), 1);
  assert.deepEqual(steps.at(-1), 'outside this advance');
});

test('advanceAsync rejects with the error of an async callback, after every due timer fired', async () => {
  const clock = createFakeClock();
  const onClock = ms => new Promise(resolve => clock.setTimer(resolve, ms));
  const fired = [];
  clock.setTimer(async () => {
    fired.push('failing');
    await onClock(10);
    throw new Error('the tick failed');
  }, 100);
  clock.setTimer(() => fired.push('later'), 500);
  await assert.rejects(clock.advanceAsync(1000), /the tick failed/);
  assert.deepEqual(fired, ['failing', 'later']);
  assert.equal(clock.now(), FAKE_CLOCK_START + 1000);
  // A callback that throws synchronously fails the call at once, as in `advance`.
  clock.setTimer(() => {
    throw new Error('thrown at once');
  }, 1);
  await assert.rejects(clock.advanceAsync(1), /thrown at once/);
});

test('the methods are bound, so they can be handed over one by one', () => {
  const { now, setTimer, clearTimer, advance } = createFakeClock();
  let fired = false;
  const id = setTimer(() => {
    fired = true;
  }, 5);
  clearTimer(id);
  setTimer(() => {
    fired = true;
  }, 5);
  advance(5);
  assert.ok(fired);
  assert.equal(now(), FAKE_CLOCK_START + 5);
  assert.throws(() => setTimer('not a function', 1), TypeError);
});
