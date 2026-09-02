/**
 * LLMClient behavior specs: model resolution, API keys, retries, abort/timeout,
 * error taxonomy, usage normalization, ledger events, streaming vs collect.
 *
 * Supersedes server/tests/workflow-llm-retry.test.js (retry loop) and
 * server/tests/workflowLLMHelper-abort-signal.test.js (#1683 signal threading).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient, toLLMError, normalizeChunk } from '../../services/loop/LLMClient.js';
import { LLM_ERROR_CODES, isLLMError, isAbortError } from '../../services/loop/contracts/errors.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import {
  makeClient,
  sseResponse,
  jsonResponse,
  textResponse,
  openaiText,
  captureRunLog,
  MODELS
} from './helpers/llmFixtures.js';

const messages = [{ role: 'user', content: 'hi' }];

test('resolveModel / findModel — candidates, default fallback, disabled, text-capable', () => {
  const { client } = makeClient({ transport: async () => sseResponse([]) });
  assert.equal(client.resolveModel({}).id, 'oa', 'platform default wins with no candidates');
  assert.equal(client.resolveModel({ modelId: 'nope', preferredIds: ['gm'] }).id, 'gm');
  assert.equal(client.resolveModel({ modelId: 'nope', fallbackToDefault: false }), null);
  assert.equal(client.findModel('off'), null, 'disabled hidden by default');
  assert.equal(client.findModel('off', { includeDisabled: true }).id, 'off');
  const { client: imgClient } = makeClient({
    transport: async () => sseResponse([]),
    models: [
      { id: 'img', provider: 'google', supportsImageGeneration: true, default: true },
      { id: 'tr', provider: 'openai', modelType: 'transcription' },
      { id: 'txt', provider: 'openai' }
    ]
  });
  assert.equal(imgClient.resolveModel({ requireTextCapable: true }).id, 'txt');
  assert.equal(imgClient.resolveModel({}).id, 'img');
});

test('execute — unknown model and missing API key are typed errors, no transport call', async () => {
  const { client, calls } = makeClient({ transport: async () => sseResponse([]) });
  await assert.rejects(client.execute({ modelId: 'nope', messages }), err => {
    assert.ok(isLLMError(err));
    assert.equal(err.code, LLM_ERROR_CODES.MODEL_NOT_FOUND);
    return true;
  });
  const noKey = new LLMClient({
    transport: async () => sseResponse([]),
    getModels: () => ({ data: [MODELS.openai] }),
    apiKeyVerifier: {
      verifyApiKey: async () => ({
        success: false,
        error: Object.assign(new Error('API key for openai not found'), { code: 'API_KEY_ERROR' })
      })
    }
  });
  await assert.rejects(noKey.execute({ modelId: 'oa', messages }), err => {
    assert.equal(err.code, LLM_ERROR_CODES.AUTH_FAILED);
    assert.equal(err.providerCode, 'API_KEY_ERROR');
    assert.match(err.message, /API key for openai not found/);
    return true;
  });
  assert.equal(calls.length, 0);
  await assert.rejects(client.execute({ modelId: 'oa', messages: 'hi' }), {
    code: LLM_ERROR_CODES.INVALID_REQUEST
  });
});

test('complete — streams OpenAI deltas into one result with usage and finishReason', async () => {
  const { client, calls } = makeClient({
    transport: async () =>
      sseResponse(
        openaiText(['Hel', 'lo'], {
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }
        }),
        { chunkSize: 7 }
      )
  });
  const result = await client.complete({
    modelId: 'oa',
    messages,
    options: { temperature: 0.2 },
    telemetry: { autoRun: false }
  });
  assert.equal(result.content, 'Hello');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.complete, true);
  assert.deepEqual(
    { p: result.usage.promptTokens, c: result.usage.completionTokens, t: result.usage.totalTokens },
    { p: 9, c: 2, t: 11 }
  );
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.model.id, 'oa');
  assert.match(result.requestId, /^req-/);
  assert.equal(calls.length, 1);
  const { request, ctx } = calls[0];
  assert.equal(request.body.stream, true, 'streaming by default');
  assert.equal(request.body.temperature, 0.2);
  assert.equal(request.body.maxTokens, 4096, 'output cap defaults to model.maxOutputTokens');
  assert.equal(ctx.model.id, 'oa');
  assert.equal(request.headers.Authorization, 'Bearer sk-test');
});

test('execute — signal is threaded to the transport; pre-aborted signal → ABORTED after one attempt', async () => {
  let attempts = 0;
  const { client, calls } = makeClient({
    transport: async (_req, { signal }) => {
      attempts += 1;
      if (signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return sseResponse(openaiText(['hi']));
    }
  });
  const controller = new AbortController();
  const stream = await client.execute({ modelId: 'oa', messages, signal: controller.signal });
  assert.equal(calls[0].ctx.signal, controller.signal);
  const result = await client.collect(stream);
  assert.equal(result.content, 'hi');

  const aborted = new AbortController();
  aborted.abort();
  attempts = 0;
  await assert.rejects(
    client.execute({ modelId: 'oa', messages, signal: aborted.signal, retries: 3 }),
    err => {
      assert.equal(err.code, LLM_ERROR_CODES.ABORTED);
      assert.ok(isAbortError(err));
      return true;
    }
  );
  assert.equal(attempts, 0, 'an already-aborted signal short-circuits before the transport');

  const late = new AbortController();
  let n = 0;
  const { client: slow } = makeClient({
    transport: async (_req, { signal }) => {
      n += 1;
      // Abort while the provider call is in flight.
      setTimeout(() => late.abort(), 0);
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      );
    }
  });
  await assert.rejects(slow.execute({ modelId: 'oa', messages, signal: late.signal, retries: 3 }), {
    code: LLM_ERROR_CODES.ABORTED
  });
  assert.equal(n, 1, 'AbortError is never retried');
});

test('execute — timeoutMs aborts a hung provider with TIMEOUT', async () => {
  const { client } = makeClient({
    transport: async (_req, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      )
  });
  await assert.rejects(client.execute({ modelId: 'oa', messages, timeoutMs: 15, retries: 0 }), {
    code: LLM_ERROR_CODES.TIMEOUT
  });
});

test('execute — transient 503/429 retried with Retry-After, non-transient 4xx not retried', async () => {
  let attempt = 0;
  const delays = [];
  const { client } = makeClient({
    transport: async () => {
      attempt += 1;
      if (attempt === 1) return textResponse('overloaded', { status: 503 });
      if (attempt === 2)
        return jsonResponse(
          { error: { message: 'slow down' } },
          { status: 429, headers: { 'retry-after': '2' } }
        );
      return sseResponse(openaiText(['ok']));
    },
    errorHandler: new ErrorHandler(),
    sleep: async ms => {
      delays.push(ms);
    }
  });
  const result = await client.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } });
  assert.equal(result.content, 'ok');
  assert.equal(attempt, 3);
  assert.equal(delays.length, 2);
  assert.equal(delays[1], 2000, 'Retry-After (seconds) wins over backoff');

  attempt = 0;
  const { client: bad } = makeClient({
    transport: async () => {
      attempt += 1;
      return jsonResponse({ error: { message: 'Unsupported parameter' } }, { status: 400 });
    },
    errorHandler: new ErrorHandler()
  });
  await assert.rejects(
    bad.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } }),
    err => {
      assert.equal(err.code, LLM_ERROR_CODES.INVALID_REQUEST);
      assert.equal(err.status, 400);
      assert.match(err.details, /Unsupported parameter/);
      return true;
    }
  );
  assert.equal(attempt, 1);

  attempt = 0;
  const { client: exhausted } = makeClient({
    transport: async () => {
      attempt += 1;
      return textResponse('down', { status: 502 });
    },
    errorHandler: new ErrorHandler(),
    maxRetries: 2
  });
  await assert.rejects(exhausted.execute({ modelId: 'oa', messages }), err => {
    assert.equal(err.code, LLM_ERROR_CODES.PROVIDER_ERROR);
    assert.equal(err.status, 502);
    assert.equal(err.retryable, true);
    return true;
  });
  assert.equal(attempt, 3);
});

test('error taxonomy — ErrorHandler codes map onto LLMError codes', async () => {
  const cases = [
    [401, 'unauthorized', LLM_ERROR_CODES.AUTH_FAILED, 'AUTH_FAILED'],
    [
      404,
      '{"error":{"message":"model `gpt-x` not found"}}',
      LLM_ERROR_CODES.MODEL_NOT_FOUND,
      'MODEL_NOT_FOUND'
    ],
    [
      400,
      '{"error":{"code":"context_length_exceeded","message":"This model maximum context length is 8192 tokens"}}',
      LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED,
      'CONTEXT_WINDOW_EXCEEDED'
    ],
    [
      400,
      '{"error":{"message":"Invalid API key provided"}}',
      LLM_ERROR_CODES.AUTH_FAILED,
      'AUTH_FAILED'
    ],
    [413, 'payload too large', LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED, 'CONTEXT_WINDOW_EXCEEDED'],
    [422, 'unprocessable', LLM_ERROR_CODES.INVALID_REQUEST, '422'],
    [429, 'rate', LLM_ERROR_CODES.RATE_LIMITED, 'RATE_LIMIT'],
    [503, 'unavailable', LLM_ERROR_CODES.PROVIDER_ERROR, 'SERVICE_UNAVAILABLE'],
    [500, 'boom', LLM_ERROR_CODES.PROVIDER_ERROR, 'SERVICE_ERROR']
  ];
  for (const [status, body, code, providerCode] of cases) {
    const { client } = makeClient({
      transport: async () => textResponse(body, { status }),
      errorHandler: new ErrorHandler(),
      maxRetries: 0
    });
    await assert.rejects(client.execute({ modelId: 'oa', messages }), err => {
      assert.equal(err.code, code, `status ${status}`);
      assert.equal(err.providerCode, providerCode, `status ${status} providerCode`);
      assert.equal(err.status, status);
      assert.equal(err.provider, 'openai');
      assert.equal(err.modelId, 'oa');
      assert.equal(err.isContextWindowError, code === LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED);
      return true;
    });
  }
});

test('toLLMError — network, timeout, abort and passthrough', () => {
  assert.equal(
    toLLMError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).code,
    'NETWORK'
  );
  assert.equal(
    toLLMError(
      Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
    ).code,
    'TIMEOUT'
  );
  assert.equal(toLLMError(Object.assign(new Error('x'), { name: 'AbortError' })).code, 'ABORTED');
  assert.equal(toLLMError(new Error('logic bug')).code, 'PROVIDER_ERROR');
  const existing = toLLMError(new Error('x'));
  assert.equal(toLLMError(existing), existing);
  assert.equal(toLLMError(new Error('x'), { timedOut: true, timeoutMs: 5 }).code, 'TIMEOUT');
});

test('execute — network failure is retried then surfaced as NETWORK with cause', async () => {
  let n = 0;
  const { client } = makeClient({
    transport: async () => {
      n += 1;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    },
    maxRetries: 1
  });
  await assert.rejects(client.execute({ modelId: 'oa', messages }), err => {
    assert.equal(err.code, LLM_ERROR_CODES.NETWORK);
    assert.equal(err.cause?.cause?.code, 'ECONNRESET');
    return true;
  });
  assert.equal(n, 2);
});

test('in-band stream error chunk → LLMError; overflow text → CONTEXT_WINDOW_EXCEEDED', async () => {
  const { client } = makeClient({
    transport: async () =>
      sseResponse([{ error: { message: 'Rate limit reached', type: 'rate_limit_error' } }])
  });
  await assert.rejects(
    client.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } }),
    err => {
      assert.equal(err.code, LLM_ERROR_CODES.PROVIDER_ERROR);
      assert.equal(err.providerCode, 'STREAM_ERROR');
      assert.match(err.message, /Rate limit reached/);
      return true;
    }
  );
  const { client: overflow } = makeClient({
    transport: async () =>
      sseResponse([{ error: { message: 'prompt is too long: 250000 tokens' } }])
  });
  await assert.rejects(
    overflow.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } }),
    {
      code: LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED
    }
  );
});

test('stream:false — one JSON body becomes a single complete chunk', async () => {
  const { client, calls } = makeClient({
    transport: async () =>
      jsonResponse({
        id: 'x',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
      })
  });
  const chunks = [];
  const result = await client.complete({
    modelId: 'oa',
    messages,
    stream: false,
    telemetry: { autoRun: false },
    onChunk: c => chunks.push(c)
  });
  assert.equal(calls[0].request.body.stream, false);
  assert.equal(chunks.length, 1);
  assert.equal(result.content, 'Hi');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.totalTokens, 4);
});

test('execute — stream is lazily parsed; result() reflects consumed chunks', async () => {
  const { client } = makeClient({
    transport: async () => sseResponse(openaiText(['a', 'b', 'c']))
  });
  const stream = await client.execute({ modelId: 'oa', messages });
  assert.equal(stream.result().content, '');
  const seen = [];
  for await (const chunk of stream) {
    seen.push(chunk.content.join(''));
    assert.deepEqual(Object.keys(chunk).includes('tool_calls'), true, 'normalized shape');
  }
  assert.deepEqual(seen.filter(Boolean), ['a', 'b', 'c']);
  assert.equal(stream.result().content, 'abc');
  assert.equal(stream.result().complete, true);
});

test('ledger — request/header per call with hash dedupe, retry and error events', async () => {
  const { runLog, events } = await captureRunLog();
  let attempt = 0;
  const { client } = makeClient({
    runLog,
    transport: async () => {
      attempt += 1;
      if (attempt === 1) return textResponse('busy', { status: 503 });
      return sseResponse(openaiText(['ok']));
    },
    errorHandler: new ErrorHandler()
  });
  const { runId } = await runLog.startRun({ kind: 'workflow', user: { id: 'u1' } });
  await client.complete({
    modelId: 'oa',
    messages,
    options: { temperature: 0.1, tools: [{ id: 't', name: 't', parameters: {} }] },
    telemetry: { runId, step: 2, purpose: 'planner', toolExecution: 'server' }
  });
  await client.complete({ modelId: 'oa', messages, telemetry: { runId, step: 3 } });
  await client.complete({
    modelId: 'oa',
    messages: [...messages, { role: 'assistant', content: 'ok' }],
    telemetry: { runId, step: 4 }
  });
  const headers = events.filter(e => e.type === RUN_LOG_EVENTS.REQUEST_HEADER);
  assert.equal(headers.length, 3);
  assert.deepEqual(
    headers.map(h => h.data.reason),
    ['initial', 'same', 'change']
  );
  assert.ok(Array.isArray(headers[0].data.messages), 'initial records messages');
  assert.equal(headers[1].data.messages, undefined, 'same omits messages');
  assert.ok(Array.isArray(headers[2].data.messages), 'change records messages');
  assert.equal(headers[0].data.step, 2);
  assert.equal(headers[0].data.purpose, 'planner');
  assert.equal(headers[0].data.toolExecution, 'server');
  assert.equal(typeof headers[0].data.toolSchemasHash, 'string');
  assert.equal(headers[1].data.toolSchemasHash, null);
  assert.equal(headers[0].data.callConfig.temperature, 0.1);
  assert.equal(headers[0].data.callConfig.stream, true);
  assert.match(headers[0].data.requestHash, /^[0-9a-f]{64}$/);
  const retries = events.filter(e => e.type === RUN_LOG_EVENTS.REQUEST_RETRY);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].data.status, 503);
  assert.equal(retries[0].data.attempt, 1);

  const { client: failing } = makeClient({
    runLog,
    transport: async () => textResponse('nope', { status: 400 }),
    errorHandler: new ErrorHandler()
  });
  await assert.rejects(failing.execute({ modelId: 'oa', messages, telemetry: { runId, step: 5 } }));
  const errors = events.filter(e => e.type === RUN_LOG_EVENTS.ERROR);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].data.code, LLM_ERROR_CODES.INVALID_REQUEST);
  assert.equal(errors[0].data.status, 400);
  await runLog.stop();
});

test('complete — without a runId opens and closes its own ledger run', async () => {
  const { runLog, events } = await captureRunLog();
  const { client } = makeClient({
    runLog,
    transport: async () =>
      sseResponse(openaiText(['title'], { usage: { prompt_tokens: 5, completion_tokens: 1 } }))
  });
  const result = await client.complete({
    modelId: 'oa',
    messages,
    telemetry: {
      kind: 'utility',
      purpose: 'title',
      user: { id: 'u9' },
      refs: { executionId: 'e1' }
    }
  });
  assert.equal(result.content, 'title');
  const types = events.map(e => e.type);
  assert.deepEqual(types, [
    RUN_LOG_EVENTS.RUN_START,
    RUN_LOG_EVENTS.REQUEST_HEADER,
    RUN_LOG_EVENTS.MESSAGE_ASSISTANT,
    RUN_LOG_EVENTS.RUN_END
  ]);
  assert.equal(events[0].data.kind, 'utility');
  assert.equal(events[0].data.principal.id, 'u9');
  assert.equal(events[0].data.refs.executionId, 'e1');
  assert.equal(events[2].data.content, 'title');
  assert.equal(events[3].data.status, 'completed');
  assert.equal(events[3].data.usage.promptTokens, 5);
  assert.equal(result.runId, events[0].runId);

  const { client: failing } = makeClient({
    runLog,
    transport: async () => textResponse('nope', { status: 401 }),
    errorHandler: new ErrorHandler(),
    maxRetries: 0
  });
  events.length = 0;
  await assert.rejects(
    failing.complete({ modelId: 'oa', messages, telemetry: { kind: 'utility' } })
  );
  const end = events.find(e => e.type === RUN_LOG_EVENTS.RUN_END);
  assert.equal(end.data.status, 'error');
  assert.equal(end.data.error.code, LLM_ERROR_CODES.AUTH_FAILED);
  await runLog.stop();
});

test('normalizeChunk — arrays always present, bedrock top-level usage lifted', () => {
  const c = normalizeChunk({ content: ['a'], usage: { promptTokens: 1, completionTokens: 2 } });
  assert.deepEqual(c.tool_calls, []);
  assert.deepEqual(c.thinking, []);
  assert.equal(c.metadata.usage.totalTokens, 3);
  assert.equal(c.usage.totalTokens, 3);
  const empty = normalizeChunk({ complete: true, finishReason: 'stop' });
  assert.deepEqual(empty.content, []);
  assert.equal(empty.usage, undefined);
  assert.equal(empty.complete, true);
});

test('createCompletionRequest is awaited (async adapters) and requests without url are rejected', async () => {
  const { client } = makeClient({ transport: async () => sseResponse(openaiText(['x'])) });
  client.createRequest = async () => ({ headers: {}, body: {} });
  await assert.rejects(client.execute({ modelId: 'oa', messages }), {
    code: LLM_ERROR_CODES.INVALID_REQUEST,
    providerCode: 'ADAPTER_REQUEST_INVALID'
  });
});

test('iassistant-conversation — stream forced on and null API key accepted', async () => {
  const { client, calls } = makeClient({
    transport: async () =>
      sseResponse([
        { __raw: 'event: answer\ndata: {"delta":"Hallo"}\n\nevent: done\ndata: {}\n\n' }
      ])
  });
  const result = await client.complete({
    modelId: 'ia',
    messages,
    stream: false,
    telemetry: { autoRun: false }
  });
  assert.equal(calls[0].request.body.stream, true);
  assert.equal(calls[0].request.headers.Authorization, 'Bearer null');
  assert.equal(result.content, 'Hallo');
  assert.equal(result.finishReason, 'stop');
});
