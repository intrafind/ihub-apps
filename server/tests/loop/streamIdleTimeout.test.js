/**
 * Stream-idle deadline specs.
 *
 * The connect ceiling only covers the phase before the first byte and the
 * whole-call deadline is five minutes, so a provider that streamed part of an
 * answer and then went quiet without closing the body or sending a finish
 * reason held the turn open for those five minutes. On the client that looked
 * like a hung chat: the streamed text was on screen, the stop button stayed
 * lit and the answer-source badge never appeared, because no `step/completed`
 * or `run/ended` frame had been emitted. Some OpenAI-compatible servers
 * (self-hosted vLLM builds among them) do exactly this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_ERROR_CODES, isLLMError } from '../../services/loop/contracts/errors.js';
import { makeClient, fakeResponse, openaiText } from './helpers/llmFixtures.js';

const messages = [{ role: 'user', content: 'hi' }];
const encoder = new TextEncoder();

const wireOf = events =>
  events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');

/**
 * SSE response that emits `events` and then holds the body open forever — no
 * finish reason, no `[DONE]`, no close.
 *
 * Deliberately ignores the request signal, unlike a real undici body: the
 * deadline has to hold even for a body that never errors on abort, which is
 * why LLMClient races the read instead of only aborting.
 */
function stallingSseResponse(events) {
  const wire = wireOf(events);
  return fakeResponse({
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(wire));
        // Never closed: the reader's next read() stays pending.
      }
    }),
    text: wire
  });
}

/** Same, but errors the body when the request is aborted — as undici does. */
function abortAwareStallingSseResponse(events, signal) {
  const wire = wireOf(events);
  return fakeResponse({
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(wire));
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          try {
            controller.error(err);
          } catch {
            /* already closed */
          }
        });
      }
    }),
    text: wire
  });
}

const partialAnswer = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: 'Half an ' } }] },
  { choices: [{ index: 0, delta: { content: 'answer' } }] }
];

test('a stream that goes quiet mid-answer fails as a TIMEOUT well before the whole-call deadline', async () => {
  const { client } = makeClient({
    streamIdleTimeoutMs: 60,
    transport: () => stallingSseResponse(partialAnswer)
  });

  const started = Date.now();
  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 10_000 });
  await assert.rejects(client.collect(stream), err => {
    assert.ok(isLLMError(err), 'is a typed LLMError');
    assert.equal(err.code, LLM_ERROR_CODES.TIMEOUT);
    assert.equal(err.providerCode, 'STREAM_IDLE_TIMEOUT');
    assert.match(err.message, /stopped sending stream chunks/);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `failed on the idle deadline, not the call deadline (${elapsed}ms)`);
});

test('the chunks delivered before the stall reach the consumer', async () => {
  const { client } = makeClient({
    streamIdleTimeoutMs: 60,
    transport: () => stallingSseResponse(partialAnswer)
  });

  const seen = [];
  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 10_000 });
  await assert.rejects(client.collect(stream, { onChunk: c => seen.push(c) }));
  assert.equal(
    seen.map(c => (c.content || []).join('')).join(''),
    'Half an answer',
    'the partial answer is not thrown away by the deadline'
  );
});

test('a stream that finishes normally is untouched by the idle deadline', async () => {
  const { client } = makeClient({
    streamIdleTimeoutMs: 60,
    transport: () => stallingSseResponse(openaiText(['all ', 'done']))
  });

  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 10_000 });
  const result = await client.collect(stream);
  assert.equal(result.content, 'all done');
  assert.equal(result.finishReason, 'stop');
});

test('the wait for the first chunk is left to the whole-call deadline', async () => {
  // Reasoning models can be silent for a long time before the first token;
  // only the gaps *after* a chunk has been produced are the provider stalling.
  const { client } = makeClient({
    streamIdleTimeoutMs: 60,
    transport: () =>
      fakeResponse({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  openaiText(['late'])
                    .map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
                    .join('')
                )
              );
              controller.close();
            }, 300);
          }
        }),
        text: ''
      })
  });

  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 10_000 });
  const result = await client.collect(stream);
  assert.equal(result.content, 'late');
});

test('streamIdleTimeoutMs <= 0 disables the idle deadline', async () => {
  const { client } = makeClient({
    streamIdleTimeoutMs: 0,
    transport: (request, ctx) => abortAwareStallingSseResponse(partialAnswer, ctx.signal)
  });

  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 300 });
  await assert.rejects(client.collect(stream), err => {
    // Falls through to the whole-call deadline, as before.
    assert.equal(err.providerCode, 'TIMEOUT');
    return true;
  });
});
