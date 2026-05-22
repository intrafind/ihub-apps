#!/usr/bin/env node

/**
 * Unit tests for the InMemorySink byte cap.
 *
 * The sink accumulates streamed chunks, tool calls, and citations from the
 * App-as-tool gateway. Without a cap, a single recursive agent run can pin
 * arbitrary heap. This test simulates streaming events and asserts the
 * sink errors out with the expected payload past `MAX_SINK_BYTES`.
 *
 * Run directly: `node server/tests/inmemory-sink-overflow.test.js`.
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
  console.log('🧪 InMemorySink — accepts small payloads\n');
  {
    const sink = new InMemorySink({ chatId: 'small-test' });
    sink.startListening();
    actionTracker.emit('fire-sse', {
      event: 'chunk',
      chatId: 'small-test',
      content: 'hello world'
    });
    actionTracker.emit('fire-sse', { event: 'done', chatId: 'small-test' });
    const result = await sink.getResult({ timeoutMs: 1_000 });
    sink.stopListening();
    check('small chunk delivered as final message', result.status === 'ok');
    check(
      'final message has the joined content',
      result.finalMessage?.content === 'hello world',
      `got ${JSON.stringify(result.finalMessage)}`
    );
  }

  console.log('\n🧪 InMemorySink — rejects oversized streams\n');
  {
    const sink = new InMemorySink({ chatId: 'overflow-test' });
    sink.startListening();
    // 11 × 1MB chunks blow past the 10 MB cap.
    const big = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 11; i++) {
      actionTracker.emit('fire-sse', {
        event: 'chunk',
        chatId: 'overflow-test',
        content: big
      });
    }
    // The sink should already have marked done with an error payload —
    // the explicit done emit is harmless because `_markDone` is idempotent.
    actionTracker.emit('fire-sse', { event: 'done', chatId: 'overflow-test' });
    const result = await sink.getResult({ timeoutMs: 1_000 });
    sink.stopListening();
    check('overflowed sink returns status=error', result.status === 'error');
    check(
      'error payload identifies sink overflow',
      typeof result.error?.message === 'string' && result.error.message.includes('overflow'),
      `got ${JSON.stringify(result.error)}`
    );
    check(
      'limit is reported in error details',
      result.error?.details?.limit === 10 * 1024 * 1024,
      `got ${JSON.stringify(result.error?.details)}`
    );
  }

  console.log('\n🧪 InMemorySink — chatId filtering\n');
  {
    const sink = new InMemorySink({ chatId: 'isolated-test' });
    sink.startListening();
    actionTracker.emit('fire-sse', {
      event: 'chunk',
      chatId: 'other-conversation',
      content: 'should be ignored'
    });
    actionTracker.emit('fire-sse', {
      event: 'chunk',
      chatId: 'isolated-test',
      content: 'real content'
    });
    actionTracker.emit('fire-sse', { event: 'done', chatId: 'isolated-test' });
    const result = await sink.getResult({ timeoutMs: 1_000 });
    sink.stopListening();
    check(
      'cross-chat noise filtered out',
      result.finalMessage?.content === 'real content',
      `got ${JSON.stringify(result.finalMessage)}`
    );
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
