#!/usr/bin/env node

/**
 * Tests for parseSseStream.js.
 *
 * Covers the SSE `id:` field, previously intentionally ignored — now captured
 * and passed to the caller's onEvent as a third argument so a dropped stream
 * can be resumed with `Last-Event-ID` (see useEventSource.js).
 *
 * Also covers that a reader.read() failure no longer emits its own 'error'
 * event — it just rethrows, leaving the retry-vs-surface decision to the
 * caller (useEventSource's reconnect logic).
 *
 * Run directly: `node client/src/shared/utils/parseSseStream.test.js`.
 */

import { parseSseStream } from './parseSseStream.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

// A fake ReadableStream body: getReader() returns a reader whose read() calls
// are driven by a queue of chunks (strings) or thrown errors.
function fakeBody(steps) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= steps.length) return { done: true, value: undefined };
          const step = steps[i++];
          if (step && step.error) throw step.error;
          if (step === null) return { done: true, value: undefined };
          return { done: false, value: new TextEncoder().encode(step) };
        },
        async cancel() {},
        releaseLock() {}
      };
    }
  };
}

async function run() {
  console.log('🧪 parseSseStream\n');

  // ---- id: field is captured and passed to onEvent ----
  {
    const events = [];
    const body = fakeBody(['id: 42\nevent: chunk\ndata: {"content":"hi"}\n\n', null]);
    await parseSseStream(body, (name, data, id) => events.push({ name, data, id }));
    check(
      'id: field is passed through as the third onEvent argument',
      events.length === 1 && events[0].id === '42' && events[0].data.content === 'hi',
      JSON.stringify(events)
    );
  }

  // ---- id resets between events (not carried over to an event without one) ----
  {
    const events = [];
    const body = fakeBody([
      'id: 1\nevent: chunk\ndata: {"content":"a"}\n\nevent: chunk\ndata: {"content":"b"}\n\n',
      null
    ]);
    await parseSseStream(body, (name, data, id) => events.push({ name, data, id }));
    check(
      "an event with no id: line gets undefined, not the previous event's id",
      events.length === 2 && events[0].id === '1' && events[1].id === undefined,
      JSON.stringify(events)
    );
  }

  // ---- reader.read() failure rethrows without emitting its own 'error' event ----
  {
    const events = [];
    const readError = new Error('socket hang up');
    const body = fakeBody(['event: chunk\ndata: {"content":"partial"}\n\n', { error: readError }]);
    let thrown = null;
    try {
      await parseSseStream(body, (name, data, id) => events.push({ name, data, id }));
    } catch (err) {
      thrown = err;
    }
    check('a read failure rethrows the original error', thrown === readError);
    check(
      'no synthetic error event is emitted by parseSseStream itself — caller decides',
      events.every(e => e.name !== 'error'),
      JSON.stringify(events)
    );
    check('events read before the failure are still delivered', events.length === 1);
  }

  // ---- AbortError during read() is swallowed (intentional cancellation) ----
  {
    const events = [];
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const body = fakeBody([{ error: abortErr }]);
    let thrown = null;
    try {
      await parseSseStream(body, (name, data, id) => events.push({ name, data, id }));
    } catch (err) {
      thrown = err;
    }
    check('AbortError during read() does not propagate', thrown === null);
  }

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
