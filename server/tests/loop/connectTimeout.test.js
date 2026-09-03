/**
 * Connect/headers-phase deadline specs.
 *
 * The whole-call deadline (REQUEST_TIMEOUT, 5 min) is sized for long
 * generations, so on its own it also governed a provider that never answered:
 * a VPN-only endpoint with the VPN down has its SYNs blackholed rather than
 * refused, so a chat turn sat for the full five minutes holding one of the
 * browser's ~6 per-origin connections. These specs pin the separation between
 * "cannot reach the provider" and "the provider is generating slowly".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_ERROR_CODES, isLLMError } from '../../services/loop/contracts/errors.js';
import { RETRYABLE_LLM_ERROR_CODES } from '../../services/loop/contracts/errors.js';
import { makeClient, sseResponse, openaiText } from './helpers/llmFixtures.js';

const messages = [{ role: 'user', content: 'hi' }];

test('a provider that never sends headers fails as a TIMEOUT, not after the whole-call deadline', async () => {
  const { client, calls } = makeClient({
    connectTimeoutMs: 40,
    maxRetries: 0,
    // Never resolves: models an endpoint whose SYNs are dropped.
    transport: (request, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
  });

  const started = Date.now();
  await assert.rejects(client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 }), err => {
    assert.ok(isLLMError(err), 'is a typed LLMError');
    assert.equal(err.code, LLM_ERROR_CODES.TIMEOUT);
    assert.equal(err.providerCode, 'CONNECT_TIMEOUT');
    assert.match(err.message, /unreachable/);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `failed fast, not on the whole-call deadline (took ${elapsed}ms)`);
  assert.equal(calls.length, 1, 'one attempt with retries disabled');
});

test('the connect deadline is transient, so the retry budget still applies', async () => {
  assert.ok(
    RETRYABLE_LLM_ERROR_CODES.has(LLM_ERROR_CODES.TIMEOUT),
    'TIMEOUT is transient, so a blackholed connect is retried rather than surfaced instantly'
  );

  let attempts = 0;
  const { client } = makeClient({
    connectTimeoutMs: 40,
    maxRetries: 2,
    transport: (request, ctx) => {
      attempts += 1;
      // Recover on the last allowed attempt.
      if (attempts > 2) return Promise.resolve(sseResponse(openaiText(['recovered'])));
      return new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
  });

  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 });
  const res = await client.collect(stream);
  assert.equal(res.content, 'recovered');
  assert.equal(attempts, 3, 'two connect timeouts then a success');
});

test('slow headers followed by a long stream are NOT killed by the connect deadline', async () => {
  const { client } = makeClient({
    connectTimeoutMs: 200,
    maxRetries: 0,
    // Headers arrive inside the connect window; the body then takes far longer
    // than that window, which must not be aborted.
    transport: async () => {
      await new Promise(r => setTimeout(r, 50));
      return sseResponse(openaiText(['slow but healthy']));
    }
  });

  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 });
  const res = await client.collect(stream);
  assert.equal(res.content, 'slow but healthy');
});

test('connectTimeoutMs <= 0 disables the phase deadline', async () => {
  const { client } = makeClient({
    connectTimeoutMs: 0,
    maxRetries: 0,
    transport: async () => {
      await new Promise(r => setTimeout(r, 60));
      return sseResponse(openaiText(['no phase deadline']));
    }
  });
  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 });
  const res = await client.collect(stream);
  assert.equal(res.content, 'no phase deadline');
});
