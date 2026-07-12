#!/usr/bin/env node

/**
 * Regression test for the InMemorySink `fire-sse` listener leak.
 *
 * `actionTracker` is a process-wide singleton EventEmitter. `getResult()` used
 * to skip `stopListening()` on the non-streaming (tool-less app) success path,
 * so every invocation left a listener registered forever. This asserts every
 * `getResult()` exit path releases the listener.
 *
 * Run directly: `node server/tests/inmemory-sink-listener-leak.test.js`.
 */

import { InMemorySink } from '../services/chat/streamSink/InMemorySink.js';
import { actionTracker } from '../actionTracker.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function run() {
  const baseline = actionTracker.listenerCount('fire-sse');

  console.log('🧪 InMemorySink — non-streaming success path releases the listener\n');
  {
    const sink = new InMemorySink({ chatId: 'leak-test-nonstreaming' });
    sink.startListening();
    check('listener registered by startListening', sink._listener !== null);
    check('listener count bumped by one', actionTracker.listenerCount('fire-sse') === baseline + 1);

    // Simulate the res-shim path (NonStreamingHandler writes the final
    // response directly): no `fire-sse` traffic is ever emitted for this
    // chatId, so getResult() must take the early-return JSON-body branch.
    sink.json({ choices: [{ message: { content: 'hi' } }] });
    const result = await sink.getResult({ timeoutMs: 1_000 });

    check('result assembled from the JSON body', result.finalMessage?.content === 'hi');
    check('listener cleared after getResult()', sink._listener === null);
    check(
      'listener count back to baseline',
      actionTracker.listenerCount('fire-sse') === baseline,
      `expected ${baseline}, got ${actionTracker.listenerCount('fire-sse')}`
    );
  }

  console.log('\n🧪 InMemorySink — streaming success path still releases the listener\n');
  {
    const sink = new InMemorySink({ chatId: 'leak-test-streaming' });
    sink.startListening();
    actionTracker.emit('fire-sse', {
      event: 'chunk',
      chatId: 'leak-test-streaming',
      content: 'hello'
    });
    actionTracker.emit('fire-sse', { event: 'done', chatId: 'leak-test-streaming' });
    await sink.getResult({ timeoutMs: 1_000 });

    check('listener cleared after streaming completion', sink._listener === null);
    check(
      'listener count back to baseline',
      actionTracker.listenerCount('fire-sse') === baseline,
      `expected ${baseline}, got ${actionTracker.listenerCount('fire-sse')}`
    );
  }

  console.log('\n🧪 InMemorySink — timeout path still releases the listener\n');
  {
    const sink = new InMemorySink({ chatId: 'leak-test-timeout' });
    sink.startListening();
    // Nothing is ever emitted for this chatId, so getResult() must hit the
    // timeout branch rather than hanging — the `finally` must still run.
    let threw = false;
    try {
      await sink.getResult({ timeoutMs: 50 });
    } catch {
      threw = true;
    }
    check('getResult() rejects on timeout', threw);
    check('listener cleared after timeout', sink._listener === null);
    check(
      'listener count back to baseline',
      actionTracker.listenerCount('fire-sse') === baseline,
      `expected ${baseline}, got ${actionTracker.listenerCount('fire-sse')}`
    );
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
