// Plain-node test (node server/tests/streamBufferService.test.js).
//
// StreamBufferService/MemoryStreamBuffer back the "resumable streams"
// feature (#1497): every SSE event fired for a chat is buffered with a
// monotonic id so a reconnecting client can replay whatever it missed via
// `Last-Event-ID`, instead of silently losing a partial AI response.
import assert from 'assert';
import { MemoryStreamBuffer } from '../services/streaming/MemoryStreamBuffer.js';
import { streamBufferService } from '../services/streaming/StreamBufferService.js';

// ---- ids are monotonic per chat, independent across chats ----
{
  const buf = new MemoryStreamBuffer();
  const id1 = buf.append('chat-1', 'chunk', { content: 'a' });
  const id2 = buf.append('chat-1', 'chunk', { content: 'b' });
  const otherId1 = buf.append('chat-2', 'chunk', { content: 'x' });
  assert.strictEqual(id1, 1);
  assert.strictEqual(id2, 2);
  assert.strictEqual(otherId1, 1, 'a different chatId starts its own counter at 1');
}
console.log('✅ ids are monotonic per chat and independent across chats');

// ---- eventsSince returns only events after lastId, in order ----
{
  const buf = new MemoryStreamBuffer();
  buf.append('chat-1', 'chunk', { content: 'a' });
  buf.append('chat-1', 'chunk', { content: 'b' });
  buf.append('chat-1', 'done', { finishReason: 'stop' });

  const missed = buf.eventsSince('chat-1', 1);
  assert.strictEqual(missed.length, 2);
  assert.strictEqual(missed[0].event, 'chunk');
  assert.strictEqual(missed[0].data.content, 'b');
  assert.strictEqual(missed[1].event, 'done');

  assert.deepStrictEqual(buf.eventsSince('chat-1', 3), []);
}
console.log('✅ eventsSince replays only events after lastId, in order');

// ---- unknown/expired chat returns null, not an empty array ----
{
  const buf = new MemoryStreamBuffer();
  assert.strictEqual(
    buf.eventsSince('never-seen', 0),
    null,
    'null lets the caller distinguish "nothing buffered" from "fresh connection"'
  );
}
console.log('✅ an unknown chatId returns null so callers can tell it apart from an empty replay');

// ---- clear() removes the buffer and cancels its eviction timer ----
{
  const buf = new MemoryStreamBuffer({ ttlMs: 50 });
  buf.append('chat-1', 'chunk', { content: 'a' });
  buf.clear('chat-1');
  assert.strictEqual(buf.eventsSince('chat-1', 0), null);
}
console.log('✅ clear() removes the buffer immediately');

// ---- sliding TTL: buffer survives while events keep arriving, expires after the last one ----
{
  const buf = new MemoryStreamBuffer({ ttlMs: 30 });
  buf.append('chat-1', 'chunk', { content: 'a' });
  await new Promise(resolve => setTimeout(resolve, 20));
  buf.append('chat-1', 'chunk', { content: 'b' }); // resets the eviction timer
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.notStrictEqual(
    buf.eventsSince('chat-1', 0),
    null,
    'buffer is still alive 20ms after activity, even though 40ms have passed since creation'
  );
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(
    buf.eventsSince('chat-1', 0),
    null,
    'buffer expires ttlMs after the last event'
  );
}
console.log('✅ eviction TTL slides forward on every append instead of expiring from creation');

// ---- StreamBufferService: no-op for a falsy chatId (matches actionTracker's own guard) ----
{
  assert.strictEqual(streamBufferService.record(undefined, 'chunk', {}), undefined);
  assert.strictEqual(streamBufferService.replaySince('never-seen', 0), null);
}
console.log(
  '✅ StreamBufferService ignores events with no chatId and reports unknown chats as null'
);

console.log('\n✅ All streamBufferService checks passed');
