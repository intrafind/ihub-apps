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
import { makeClient, sseResponse, jsonResponse, openaiText } from './helpers/llmFixtures.js';
import configCache from '../../configCache.js';

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

test('the connect deadline is not retried: a blackholed host is probed once per call', async () => {
  // Retrying repeated the same 10 s wait — and, for a hostname, queued another
  // blocking getaddrinfo on the shared threadpool that stalled other callers
  // (see utils/dnsGuard.js). The TIMEOUT code stays retryable for slow reads.
  assert.ok(RETRYABLE_LLM_ERROR_CODES.has(LLM_ERROR_CODES.TIMEOUT));

  let attempts = 0;
  const { client } = makeClient({
    connectTimeoutMs: 40,
    maxRetries: 2,
    transport: (request, ctx) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
  });
  await assert.rejects(client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 }), err => {
    assert.equal(err.providerCode, 'CONNECT_TIMEOUT');
    return true;
  });
  assert.equal(attempts, 1, 'single attempt despite maxRetries: 2');
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

test('a non-streamed call is NOT capped by the connect ceiling', async () => {
  // The bug this pins: a buffered completion endpoint (Google's
  // :generateContent, and every other non-streamed one) withholds its response
  // headers until the whole answer is generated, so time-to-first-byte *is*
  // generation time. Timing it turned every summary or translation that took
  // longer than the ceiling into "endpoint unreachable" — the provider was
  // answering fine, it was just answering slowly.
  const { client } = makeClient({
    connectTimeoutMs: 40,
    maxRetries: 0,
    // Honors the signal, like a real fetch: if the ceiling applied, the
    // aborted attempt would surface as CONNECT_TIMEOUT instead of an answer.
    transport: (request, ctx) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(
          () =>
            resolve(
              jsonResponse({
                id: 'x',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ein Wort' },
                    finish_reason: 'stop'
                  }
                ]
              })
            ),
          150
        );
        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
  });

  const result = await client.complete({
    modelId: 'oa',
    messages,
    stream: false,
    telemetry: { autoRun: false },
    timeoutMs: 5_000
  });
  assert.equal(result.content, 'ein Wort');
});

test('a non-streamed call still answers to the whole-call deadline', async () => {
  // Dropping the connect ceiling for these calls must not leave them unbounded.
  const { client } = makeClient({
    connectTimeoutMs: 40,
    maxRetries: 0,
    transport: (request, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
  });

  await assert.rejects(
    client.execute({ modelId: 'oa', messages, stream: false, timeoutMs: 120 }),
    err => {
      assert.equal(err.code, LLM_ERROR_CODES.TIMEOUT);
      assert.equal(err.providerCode, 'TIMEOUT', 'the whole-call deadline, not the connect one');
      return true;
    }
  );
});

test('time queued behind the model throttle is not counted against the ceiling', async () => {
  // Every attempt goes through the per-model throttle (platform
  // requestConcurrency defaults to 5, and models can set concurrency /
  // requestDelayMs of their own). Arming the ceiling before the slot was
  // granted reported a request that had not been sent yet as an unreachable
  // endpoint — the failure a batch of translations hit once more than a
  // handful were in flight for one model.
  configCache.setCacheEntry('config/models.json', [
    { id: 'oa', provider: 'openai', modelId: 'gpt-4o-mini', requestDelayMs: 150 }
  ]);
  try {
    const { client } = makeClient({
      connectTimeoutMs: 60,
      maxRetries: 0,
      transport: async () => sseResponse(openaiText(['ok']))
    });
    // The first call primes the throttler's "last completed" stamp.
    await client.collect(await client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 }));
    // The second waits out requestDelayMs (150 ms) inside its slot — longer
    // than the 60 ms ceiling — before the request is sent at all.
    const started = Date.now();
    const res = await client.collect(
      await client.execute({ modelId: 'oa', messages, timeoutMs: 5_000 })
    );
    assert.equal(res.content, 'ok');
    assert.ok(Date.now() - started >= 100, 'the second call really did wait for its slot');
  } finally {
    configCache.setCacheEntry('config/models.json', []);
  }
});

test('platform.json llm.connectTimeoutMs sets the ceiling for the shared client', async () => {
  configCache.setCacheEntry('config/platform.json', { llm: { connectTimeoutMs: 40 } });
  try {
    const { client } = makeClient({
      maxRetries: 0,
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
      assert.equal(err.providerCode, 'CONNECT_TIMEOUT');
      return true;
    });
    assert.ok(Date.now() - started < 1_000, 'the configured 40 ms ceiling, not the 10 s default');
  } finally {
    configCache.setCacheEntry('config/platform.json', {});
  }
});

test("a model's own connectTimeoutMs overrides the platform-wide ceiling", async () => {
  const models = [
    {
      id: 'slow-vpn',
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      url: 'https://vpn-only.corp.test/v1/chat/completions',
      connectTimeoutMs: 40
    }
  ];
  const { client } = makeClient({
    models,
    connectTimeoutMs: 30_000,
    maxRetries: 0,
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
  await assert.rejects(client.execute({ modelId: 'slow-vpn', messages, timeoutMs: 5_000 }), err => {
    assert.equal(err.providerCode, 'CONNECT_TIMEOUT');
    assert.match(err.message, /connectTimeoutMs on model slow-vpn/);
    return true;
  });
  assert.ok(Date.now() - started < 1_000, "the model's 40 ms ceiling, not the client's 30 s");
});
