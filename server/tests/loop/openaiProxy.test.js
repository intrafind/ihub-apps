/**
 * Golden wire tests for the OpenAI-compatible inference API on top of LLMClient.
 * Pins the byte-level contract external clients depend on (chunk shapes, role
 * chunk ordering, tool-call replay, `[DONE]`, error envelopes, header relay) and
 * the deliberate fixes made in the rewrite (single `[DONE]`, in-band stream
 * errors, real usage, client-disconnect abort).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import configCache from '../../configCache.js';
import registerOpenAIProxyRoutes, { inferenceErrorStatus } from '../../routes/openaiProxy.js';
import { LLMError, LLM_ERROR_CODES } from '../../services/loop/contracts/errors.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import {
  makeClient,
  sseResponse,
  jsonResponse,
  textResponse,
  openaiText,
  fakeResponse,
  bytesStream,
  MODELS
} from './helpers/llmFixtures.js';

// The proxy runs behind `authRequired`; with anonymous auth disabled (the test
// default: no platform config) a request passes only when `req.user` is set.
function buildApp(client, { user = { id: 'u1', permissions: { models: new Set(['*']) } } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const header = req.headers['x-test-user'];
    if (header === 'none') req.user = undefined;
    else if (header) {
      const parsed = JSON.parse(header);
      if (parsed.permissions?.models)
        parsed.permissions.models = new Set(parsed.permissions.models);
      req.user = parsed;
    } else req.user = user;
    next();
  });
  registerOpenAIProxyRoutes(app, { llmClient: client });
  return app;
}

function sseEvents(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(line => {
      assert.ok(line.startsWith('data: '), `every frame is a data line: ${line}`);
      const payload = line.slice(6);
      return payload === '[DONE]' ? '[DONE]' : JSON.parse(payload);
    });
}

const stripIds = chunk =>
  chunk === '[DONE]' ? chunk : { ...chunk, id: '<id>', created: '<created>' };

const CHAT = '/api/inference/v1/chat/completions';

// Error texts come from shared/i18n via configCache; load the locales once so
// the golden strings below are the real user-facing ones.
test.before(async () => {
  await configCache.loadAndCacheLocale('en');
  await configCache.loadAndCacheLocale('de');
});
const body = extra => ({ model: 'oa', messages: [{ role: 'user', content: 'hi' }], ...extra });

test('GET /v1/models — permission filtering, unfiltered without a user', async () => {
  const { client } = makeClient({ transport: async () => sseResponse([]) });
  const app = buildApp(client);
  const all = await request(app).get('/api/inference/v1/models');
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body.data.map(m => m.id),
    ['oa', 'vl', 'ms', 'an', 'gm', 'or', 'br', 'ia'],
    'disabled models hidden'
  );
  assert.deepEqual(all.body.data[0], { object: 'model', id: 'oa' });

  const one = await request(app)
    .get('/api/inference/v1/models')
    .set('x-test-user', JSON.stringify({ id: 'u2', permissions: { models: ['gm'] } }));
  assert.deepEqual(one.body, { object: 'list', data: [{ object: 'model', id: 'gm' }] });

  const none = await request(app)
    .get('/api/inference/v1/models')
    .set('x-test-user', JSON.stringify({ id: 'u3', permissions: { models: [] } }));
  assert.deepEqual(none.body.data, []);

  configCache.cache.set('config/platform.json', { data: { anonymousAuth: { enabled: true } } });
  try {
    const anon = await request(app).get('/api/inference/v1/models').set('x-test-user', 'none');
    assert.equal(anon.status, 200);
    assert.equal(anon.body.data.length, 8, 'no user → no permission filtering');
  } finally {
    configCache.cache.delete('config/platform.json');
  }
});

test('POST validation — missing fields, unknown/disabled model, permission denial, language', async () => {
  const { client, calls } = makeClient({ transport: async () => sseResponse([]) });
  const app = buildApp(client);

  let res = await request(app).post(CHAT).send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Missing required fields' });

  res = await request(app).post(CHAT).set('Accept-Language', 'de').send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Erforderliche Felder fehlen' });

  res = await request(app).post(CHAT).send({ model: 'oa', messages: 'hi' });
  assert.equal(res.status, 400, 'non-array messages are rejected up front');

  res = await request(app)
    .post(CHAT)
    .send(body({ model: 'nope' }));
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Model not found' });

  res = await request(app)
    .post(CHAT)
    .send(body({ model: 'off' }));
  assert.equal(res.status, 404, 'disabled model is not found');

  res = await request(app)
    .post(CHAT)
    .send(body({ model: 'gpt-4o' }));
  assert.equal(res.status, 404, 'upstream modelId is not an iHub id');

  res = await request(app)
    .post(CHAT)
    .set('x-test-user', JSON.stringify({ id: 'u2', permissions: { models: ['gm'] } }))
    .send(body());
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'API key is not allowed to use this model' });
  assert.equal(calls.length, 0, 'no upstream call on any validation failure');
});

test('missing API key → 500 with the localized apiKeyNotFound text, no upstream call', async () => {
  const { client, calls } = makeClient({
    transport: async () => sseResponse([]),
    apiKeyVerifier: {
      verifyApiKey: async () => ({
        success: false,
        error: Object.assign(new Error('API key not found for provider: openai'), {
          code: 'API_KEY_ERROR'
        })
      })
    }
  });
  const res = await request(buildApp(client)).post(CHAT).send(body());
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'API key not found for provider: openai');
  assert.equal(res.body.code, 'AUTH_FAILED');
  assert.equal(calls.length, 0);
});

test('upstream request construction through the real OpenAI adapter', async () => {
  const { client, calls } = makeClient({
    realRequest: true,
    transport: async () => sseResponse(openaiText(['ok']))
  });
  const app = buildApp(client);
  await request(app)
    .post(CHAT)
    .send(body({ stream: true, max_tokens: 5 }));
  const { request: req, ctx } = calls[0];
  assert.equal(req.url, MODELS.openai.url);
  assert.equal(req.headers.Authorization, 'Bearer sk-test');
  assert.equal(req.body.model, 'gpt-4o');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.max_tokens, 5);
  assert.equal(req.body.temperature, 0.7);
  assert.deepEqual(req.body.stream_options, { include_usage: true });
  assert.ok(ctx.signal instanceof AbortSignal, 'client-disconnect abort signal is wired');

  await request(app)
    .post(CHAT)
    .send(
      body({
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'd',
              parameters: { type: 'object', properties: { city: { type: 'string' } } }
            }
          }
        ],
        tool_choice: 'auto'
      })
    );
  const toolReq = calls[1].request.body;
  assert.equal(toolReq.stream, false);
  assert.equal(toolReq.tool_choice, 'auto');
  assert.equal(toolReq.tools[0].function.name, 'get_weather');
  assert.deepEqual(toolReq.tools[0].function.parameters.properties, { city: { type: 'string' } });
  assert.equal(
    toolReq.max_tokens,
    MODELS.openai.maxOutputTokens,
    'omitted max_tokens falls back to the model cap'
  );
});

test('upstream HTTP errors relay the upstream status with a JSON envelope (stream and non-stream)', async () => {
  const { client } = makeClient({
    transport: async () =>
      jsonResponse(
        { error: { message: 'rate' } },
        { status: 429, headers: { 'retry-after': '1' } }
      ),
    errorHandler: new ErrorHandler()
  });
  const app = buildApp(client);
  for (const stream of [false, true]) {
    const res = await request(app).post(CHAT).send(body({ stream }));
    assert.equal(res.status, 429);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.body.code, 'RATE_LIMITED');
    assert.match(res.body.error, /Rate limit exceeded/);
    assert.equal(res.body.details, '{"error":{"message":"rate"}}');
  }
  const { client: failing } = makeClient({
    transport: async () => textResponse('boom', { status: 500 }),
    errorHandler: new ErrorHandler()
  });
  const res = await request(buildApp(failing)).post(CHAT).send(body());
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'PROVIDER_ERROR');
  assert.equal(res.body.details, 'boom');
});

test('inferenceErrorStatus mapping', () => {
  const mk = (code, extra = {}) => new LLMError('x', { code, ...extra });
  assert.equal(inferenceErrorStatus(mk(LLM_ERROR_CODES.PROVIDER_ERROR, { status: 503 })), 503);
  assert.equal(
    inferenceErrorStatus(mk(LLM_ERROR_CODES.AUTH_FAILED, { providerCode: 'API_KEY_ERROR' })),
    500
  );
  assert.equal(inferenceErrorStatus(mk(LLM_ERROR_CODES.AUTH_FAILED)), 401);
  assert.equal(inferenceErrorStatus(mk(LLM_ERROR_CODES.MODEL_NOT_FOUND)), 404);
  assert.equal(inferenceErrorStatus(mk(LLM_ERROR_CODES.INVALID_REQUEST)), 400);
  assert.equal(inferenceErrorStatus(mk(LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED)), 400);
  assert.equal(inferenceErrorStatus(mk(LLM_ERROR_CODES.RATE_LIMITED)), 429);
  assert.equal(inferenceErrorStatus(mk(LLM_ERROR_CODES.TIMEOUT)), 504);
  assert.equal(inferenceErrorStatus(mk(LLM_ERROR_CODES.NETWORK)), 502);
  assert.equal(inferenceErrorStatus(new Error('plain')), 500);
});

test('non-streaming — chat.completion with real usage, regenerated id, iHub model id', async () => {
  const { client } = makeClient({
    transport: async () =>
      jsonResponse({
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o-2024',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 }
      })
  });
  const res = await request(buildApp(client)).post(CHAT).send(body());
  assert.equal(res.status, 200);
  assert.match(res.body.id, /^chatcmpl-[0-9a-f]{32}$/);
  assert.equal(res.body.object, 'chat.completion');
  assert.equal(typeof res.body.created, 'number');
  assert.equal(res.body.model, 'oa');
  assert.deepEqual(res.body.choices, [
    { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }
  ]);
  assert.deepEqual(res.body.usage, { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 });
  assert.deepEqual(Object.keys(res.body), ['id', 'object', 'created', 'model', 'choices', 'usage']);
});

test('non-streaming — tool calls are replayed with index/id/function and null content', async () => {
  const { client } = makeClient({
    transport: async () =>
      jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city": "Berlin"}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      })
  });
  const res = await request(buildApp(client)).post(CHAT).send(body());
  assert.equal(res.body.choices[0].finish_reason, 'tool_calls');
  assert.equal(res.body.choices[0].message.content, null);
  assert.deepEqual(res.body.choices[0].message.tool_calls, [
    {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Berlin"}' }
    }
  ]);
  assert.deepEqual(res.body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('non-streaming — Gemini thought signature surfaces as extra_content', async () => {
  const { client } = makeClient({
    transport: async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'get_weather', args: { city: 'Berlin' } },
                  thoughtSignature: 'SIG'
                }
              ],
              role: 'model'
            },
            finishReason: 'STOP'
          }
        ]
      })
  });
  const res = await request(buildApp(client))
    .post(CHAT)
    .send(body({ model: 'gm' }));
  const call = res.body.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, 'get_weather');
  assert.equal(call.function.arguments, '{"city":"Berlin"}');
  assert.deepEqual(call.extra_content, { google: { thought_signature: 'SIG' } });
  assert.equal(res.body.choices[0].finish_reason, 'tool_calls');
});

test('streaming — content deltas: role on the first written chunk, one [DONE], SSE headers', async () => {
  const { client } = makeClient({
    transport: async () =>
      sseResponse(
        openaiText(['Hel', 'lo'], {
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
        }),
        { chunkSize: 3 }
      )
  });
  const res = await request(buildApp(client))
    .post(CHAT)
    .send(body({ stream: true }));
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  const events = sseEvents(res.text).map(stripIds);
  const base = { id: '<id>', created: '<created>', object: 'chat.completion.chunk', model: 'oa' };
  assert.deepEqual(events, [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }]
    },
    { ...base, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ]);
  const ids = new Set(
    sseEvents(res.text)
      .filter(e => e !== '[DONE]')
      .map(e => e.id)
  );
  assert.equal(ids.size, 1, 'one completion id across all chunks');
});

test('streaming — stream_options.include_usage appends a usage chunk before [DONE]', async () => {
  const { client } = makeClient({
    transport: async () =>
      sseResponse(
        openaiText(['x'], { usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })
      )
  });
  const res = await request(buildApp(client))
    .post(CHAT)
    .send(body({ stream: true, stream_options: { include_usage: true } }));
  const events = sseEvents(res.text);
  const usageChunk = events[events.length - 2];
  assert.deepEqual(usageChunk.choices, []);
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
  assert.equal(events[events.length - 1], '[DONE]');
});

test('streaming — tool call: role chunk, then a single tool_calls chunk with complete arguments', async () => {
  const { client } = makeClient({
    transport: async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] },
              finish_reason: null
            }
          ]
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"B"}' } }] },
              finish_reason: null
            }
          ]
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]'
      ])
  });
  const res = await request(buildApp(client))
    .post(CHAT)
    .send(body({ stream: true }));
  const events = sseEvents(res.text).map(stripIds);
  assert.equal(events.length, 3);
  assert.deepEqual(events[0].choices[0], {
    index: 0,
    delta: { role: 'assistant' },
    finish_reason: null
  });
  assert.deepEqual(events[1].choices[0], {
    index: 0,
    delta: {
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"B"}' }
        }
      ]
    },
    finish_reason: 'tool_calls'
  });
  assert.equal(events[2], '[DONE]');
});

test('streaming — content then tool call keeps the role on the content chunk', async () => {
  const { client } = makeClient({
    transport: async () =>
      sseResponse([
        {
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'Let me check' }, finish_reason: null }
          ]
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }
                ]
              },
              finish_reason: null
            }
          ]
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]'
      ])
  });
  const res = await request(buildApp(client))
    .post(CHAT)
    .send(body({ stream: true }));
  const events = sseEvents(res.text);
  assert.deepEqual(events[0].choices[0].delta, { role: 'assistant', content: 'Let me check' });
  assert.equal(events[1].choices[0].delta.tool_calls[0].function.name, 'f');
  assert.equal(events[1].choices[0].finish_reason, 'tool_calls');
  assert.equal(events[2], '[DONE]');
});

test('streaming — Anthropic and Gemini upstreams produce the same OpenAI wire', async () => {
  const { client: an } = makeClient({
    transport: async () =>
      sseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }
      ])
  });
  const anRes = await request(buildApp(an))
    .post(CHAT)
    .send(body({ model: 'an', stream: true }));
  const anEvents = sseEvents(anRes.text);
  assert.deepEqual(anEvents[0].choices[0].delta, { role: 'assistant', content: 'Hi' });
  assert.equal(anEvents[anEvents.length - 2].choices[0].finish_reason, 'stop');
  assert.equal(anEvents[anEvents.length - 1], '[DONE]');

  const { client: gm } = makeClient({
    transport: async () =>
      sseResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'get_weather', args: { city: 'Berlin' } },
                    thoughtSignature: 'SIG'
                  }
                ],
                role: 'model'
              },
              finishReason: 'STOP'
            }
          ]
        }
      ])
  });
  const gmRes = await request(buildApp(gm))
    .post(CHAT)
    .send(body({ model: 'gm', stream: true }));
  const gmEvents = sseEvents(gmRes.text);
  assert.deepEqual(gmEvents[0].choices[0].delta, { role: 'assistant' });
  const call = gmEvents[1].choices[0].delta.tool_calls[0];
  assert.equal(call.function.name, 'get_weather');
  assert.deepEqual(call.extra_content, { google: { thought_signature: 'SIG' } });
  assert.equal(gmEvents[1].choices[0].finish_reason, 'tool_calls');
  assert.equal(gmEvents[2], '[DONE]');
});

test('streaming — mid-stream provider error is reported in-band, then [DONE]', async () => {
  const { client } = makeClient({
    transport: async () =>
      sseResponse([
        {
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'part' }, finish_reason: null }
          ]
        },
        { error: { message: 'overloaded', type: 'server_error' } }
      ])
  });
  const res = await request(buildApp(client))
    .post(CHAT)
    .send(body({ stream: true }));
  assert.equal(res.status, 200);
  const events = sseEvents(res.text);
  assert.equal(events[0].choices[0].delta.content, 'part');
  assert.equal(events[1].error.message, 'overloaded');
  assert.equal(events[1].error.code, 'PROVIDER_ERROR');
  assert.equal(events[2], '[DONE]');
});

test('streaming — upstream [DONE] without a finish chunk still yields exactly one [DONE]', async () => {
  const { client } = makeClient({
    transport: async () =>
      sseResponse([
        {
          choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }]
        },
        '[DONE]'
      ])
  });
  const res = await request(buildApp(client))
    .post(CHAT)
    .send(body({ stream: true }));
  const events = sseEvents(res.text);
  assert.equal(events.filter(e => e === '[DONE]').length, 1);
  assert.equal(events[0].choices[0].delta.content, 'x');
});

test('client disconnect mid-stream aborts the upstream call', async () => {
  let upstreamSignal = null;
  let firstChunkSent;
  const firstChunk = new Promise(resolve => {
    firstChunkSent = resolve;
  });
  const body2 = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'a' }, finish_reason: null }] })}\n\n`
        )
      );
      firstChunkSent();
    },
    pull() {
      return new Promise((_, reject) =>
        upstreamSignal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      );
    }
  });
  const { client } = makeClient({
    transport: async (_req, ctx) => {
      upstreamSignal = ctx.signal;
      return fakeResponse({ status: 200, headers: {}, body: body2, text: '' });
    }
  });
  const app = buildApp(client);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        { port, path: CHAT, method: 'POST', headers: { 'content-type': 'application/json' } },
        res => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
          res.on('error', () => {});
        }
      );
      req.on('error', () => {});
      req.end(JSON.stringify(body({ stream: true })));
      firstChunk.catch(reject);
    });
    const deadline = Date.now() + 2000;
    while (!upstreamSignal?.aborted && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(upstreamSignal?.aborted, true, 'upstream abort follows the client disconnect');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('streaming — upstream connection drop without a finish chunk ends the stream cleanly', async () => {
  const { client } = makeClient({
    transport: async () =>
      fakeResponse({
        status: 200,
        headers: {},
        body: bytesStream([`data: ${JSON.stringify(openaiText(['partial'])[1])}\n\n`]),
        text: ''
      })
  });
  const res = await request(buildApp(client))
    .post(CHAT)
    .send(body({ stream: true }));
  assert.equal(res.status, 200);
  const events = sseEvents(res.text);
  assert.equal(events[0].choices[0].delta.content, 'partial');
  assert.equal(events[events.length - 1], '[DONE]', 'the client is never left hanging');
});
