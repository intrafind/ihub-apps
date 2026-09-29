/**
 * Route specs for the inference API extensions (#2580): apps as models,
 * `prompt.variables`, `response_format`, server-side output validation,
 * `/responses` and `/conversations`.
 *
 * Everything below the HTTP layer is real — the routes, the chat pipeline
 * (`RequestBuilder`, `PromptService`, `ChatService.runTurn`, `AgentLoop`),
 * the `LLMClient`, a filesystem storage provider over a temp dir for the
 * conversations — except the provider, which is a scripted transport, and
 * the API key check. `requests` holds what each provider call was sent, so a
 * spec can read the exact system prompt and user message the model saw.
 */
import test, { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import configCache from '../../configCache.js';
import registerOpenAIProxyRoutes from '../../routes/openaiProxy.js';
import ChatService from '../../services/chat/ChatService.js';
import RequestBuilder from '../../services/chat/RequestBuilder.js';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../../storage/bootstrap.js';
import { getChatRepository } from '../../services/chat/ChatRepository.js';
import {
  makeClient,
  sseResponse,
  textResponse,
  openaiText,
  captureRunLog
} from './helpers/llmFixtures.js';
import { abortChatRequest } from '../../sse.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

const MODEL_LIST = [
  {
    id: 'oa',
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: true,
    default: true
  },
  {
    id: 'oa2',
    provider: 'openai',
    modelId: 'gpt-4.1',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: true
  },
  {
    id: 'an',
    provider: 'anthropic',
    modelId: 'claude',
    url: 'https://api.anthropic.com/v1/messages',
    supportsTools: true
  },
  { id: 'ia', provider: 'iassistant-conversation', modelId: 'iassistant' }
];

const RISK_SCHEMA = {
  type: 'object',
  properties: { risk: { type: 'string', enum: ['low', 'high'] } },
  required: ['risk'],
  additionalProperties: false
};

const APPS = [
  {
    id: 'summarizer',
    name: { en: 'Summarizer' },
    system: { en: 'SYS doc={{document-id}} action={{action}}' },
    prompt: { en: 'TPL[{{action}}|{{max_points}}]: {{content}}' },
    variables: [
      {
        name: 'action',
        label: { en: 'Action' },
        type: 'select',
        required: true,
        predefinedValues: [
          { value: 'summarize', label: { en: 'Summarize' } },
          { value: 'translate', label: { en: 'Translate' } }
        ],
        defaultValue: { en: 'summarize' }
      },
      { name: 'max_points', label: { en: 'Max' }, type: 'number' },
      { name: 'document-id', label: { en: 'Doc' }, type: 'string' }
    ],
    preferredModel: 'oa',
    allowedModels: ['oa', 'oa2', 'an'],
    enabled: true
  },
  {
    id: 'nda',
    name: { en: 'NDA' },
    system: { en: 'NDA analyzer' },
    outputSchema: RISK_SCHEMA,
    preferredModel: 'oa',
    enabled: true
  },
  {
    id: 'locked',
    name: { en: 'Locked' },
    system: { en: 'x' },
    preferredModel: 'oa',
    disallowModelSelection: true,
    enabled: true
  },
  {
    id: 'docs',
    name: { en: 'Document actions' },
    system: { en: 'Work on document {{document-id}}.' },
    prompt: { en: 'Task: {{content}}' },
    variables: [{ name: 'document-id', label: { en: 'Document' }, type: 'string', required: true }],
    preferredModel: 'oa',
    enabled: true
  },
  {
    id: 'agent',
    name: { en: 'Agent' },
    system: { en: 'Use the lookup tool.' },
    tools: ['lookup'],
    preferredModel: 'oa',
    enabled: true
  },
  {
    id: 'auditor',
    name: { en: 'Auditor' },
    system: { en: 'Look the record up, then rate it.' },
    tools: ['lookup'],
    outputSchema: RISK_SCHEMA,
    preferredModel: 'oa',
    enabled: true
  }
];

const TOOLS = [
  {
    id: 'lookup',
    name: 'lookup',
    description: 'Look up a record',
    script: 'lookup.js',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
  }
];

const ADA = {
  id: 'user-ada',
  name: 'Ada',
  permissions: { apps: new Set(['*']), models: new Set(['*']) }
};
const GRACE = {
  id: 'user-grace',
  name: 'Grace',
  permissions: { apps: new Set(['*']), models: new Set(['*']) }
};

const CHAT = '/api/inference/v1/chat/completions';
const RESPONSES = '/api/inference/v1/responses';
const CONVERSATIONS = '/api/inference/v1/conversations';

let baseDir;
let ledger;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-inference-api-'));
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
  configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
  configCache.setCacheEntry('config/apps.json', APPS);
  configCache.setCacheEntry('config/models.json', MODEL_LIST);
  configCache.setCacheEntry('config/tools.json', TOOLS);
  await configCache.loadAndCacheLocale('en');
  ledger = await captureRunLog();
});

after(async () => {
  await shutdownStorageBootstrap();
  // A ledger flush can still land while the directories go.
  const rm = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(baseDir);
  await rm(ledger.baseDir);
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * An app over a scripted provider. `script` items are SSE event lists (or
 * functions returning a Response), consumed one per provider call.
 */
function setup(script, { user = ADA, realRequest = false, onPrepare = null } = {}) {
  const queue = [...script];
  const requests = [];
  const { client } = makeClient({
    models: MODEL_LIST,
    realRequest,
    runLog: ledger.runLog,
    transport: async (req, ctx) => {
      requests.push(req);
      const next = queue.shift();
      if (!next) throw new Error(`script exhausted after ${requests.length} calls`);
      return typeof next === 'function' ? next(req, ctx) : sseResponse(next);
    }
  });
  const requestBuilder = new RequestBuilder();
  requestBuilder.apiKeyVerifier = {
    verifyApiKey: async () => ({ success: true, apiKey: 'sk-test' })
  };
  if (onPrepare) {
    const prepare = requestBuilder.prepareChatRequest.bind(requestBuilder);
    requestBuilder.prepareChatRequest = async params => {
      const result = await prepare(params);
      await onPrepare(params);
      return result;
    };
  }
  const chatService = new ChatService({
    requestBuilder,
    agentLoop: new AgentLoop({ llmClient: client, logger: silent, runLog: ledger.runLog }),
    runLog: ledger.runLog,
    logInteraction: async () => {},
    runTool: async (toolId, args) => ({ found: true, toolId, key: args.key }),
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} }
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  let current = user;
  app.use((req, _res, next) => {
    req.user = current;
    next();
  });
  registerOpenAIProxyRoutes(app, {
    llmClient: client,
    chatService,
    getLocalizedError: async key => key,
    DEFAULT_TIMEOUT: 30000
  });
  return {
    app,
    requests,
    as: next => {
      current = next;
    }
  };
}

/** The messages a provider call was sent (the stub request echoes them). */
const sentMessages = req => req.body.messages;
const systemOf = req => sentMessages(req).find(m => m.role === 'system')?.content || '';
const lastUserOf = req => [...sentMessages(req)].reverse().find(m => m.role === 'user')?.content;

/** Anthropic's structured output: the forced `json` tool call. */
function anthropicJson(json) {
  const text = JSON.stringify(json);
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_json', name: 'json' }
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: text.slice(0, 5) }
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: text.slice(5) }
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' }
  ];
}

const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };

/** An OpenAI turn that calls one tool, optionally saying something first. */
function toolCallTurn(name, args, id = 'call_1', prose = null) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            ...(prose ? { content: prose } : {}),
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          },
          finish_reason: null
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ];
}

/** Parse an SSE body into its data payloads (Chat Completions). */
function dataFrames(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(frame => frame.replace(/^data: /, ''))
    .map(payload => (payload === '[DONE]' ? payload : JSON.parse(payload)));
}

/** Parse a Responses event stream into its events. */
function responseEvents(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(frame => {
      const [eventLine, dataLine] = frame.split('\n');
      const type = eventLine.replace(/^event: /, '');
      const data = JSON.parse(dataLine.replace(/^data: /, ''));
      assert.equal(data.type, type, 'event line and payload agree');
      return data;
    });
}

// ── /models ─────────────────────────────────────────────────────────────────

describe('GET /models', () => {
  it('lists the apps the caller may use as app:<appId>, after the models', async () => {
    const { app } = setup([]);
    const res = await request(app).get('/api/inference/v1/models');
    const ids = res.body.data.map(entry => entry.id);
    assert.deepEqual(ids, [
      'oa',
      'oa2',
      'an',
      'ia',
      'app:summarizer',
      'app:nda',
      'app:locked',
      'app:docs',
      'app:agent',
      'app:auditor'
    ]);

    const { app: narrow, as } = setup([]);
    as({ id: 'u', permissions: { apps: new Set(['nda']), models: new Set(['oa']) } });
    const scoped = await request(narrow).get('/api/inference/v1/models');
    assert.deepEqual(
      scoped.body.data.map(entry => entry.id),
      ['oa', 'app:nda'],
      'models and apps are filtered by their own permissions; no app/model combinations'
    );
  });
});

// ── /chat/completions, plain models ─────────────────────────────────────────

describe('POST /chat/completions with response_format', () => {
  const format = {
    type: 'json_schema',
    json_schema: { name: 'risk', schema: RISK_SCHEMA, strict: true }
  };

  it('sends the schema to the provider and returns the validated JSON', async () => {
    const { app, requests } = setup([openaiText(['{"risk":', '"low"}'], { usage })], {
      realRequest: true
    });
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'oa', messages: [{ role: 'user', content: 'x' }], response_format: format });
    assert.equal(res.status, 200);
    assert.equal(res.body.choices[0].message.content, '{"risk":"low"}');
    assert.equal(requests[0].body.response_format.type, 'json_schema');
    assert.equal(requests[0].body.response_format.json_schema.strict, true);
  });

  it('retries an invalid answer once with the validation errors, then succeeds', async () => {
    const { app, requests } = setup([
      openaiText(['{"risk":"medium"}']),
      openaiText(['{"risk":"high"}'])
    ]);
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'oa', messages: [{ role: 'user', content: 'x' }], response_format: format });
    assert.equal(res.status, 200);
    assert.equal(res.body.choices[0].message.content, '{"risk":"high"}');
    assert.equal(requests.length, 2);
    const retry = sentMessages(requests[1]);
    assert.equal(retry[retry.length - 2].role, 'assistant');
    assert.match(retry[retry.length - 1].content, /\/risk: must be one of "low", "high"/);
  });

  it('answers 422 with details when the retry does not validate either', async () => {
    const { app, requests } = setup([openaiText(['nope']), openaiText(['{"risk":1}'])]);
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'oa', messages: [{ role: 'user', content: 'x' }], response_format: format });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'output_validation_failed');
    assert.equal(res.body.details[0].path, '/risk');
    assert.equal(requests.length, 2);
  });

  it('?validate=false returns the raw answer without checking it', async () => {
    const { app, requests } = setup([openaiText(['not json'])]);
    const res = await request(app)
      .post(`${CHAT}?validate=false`)
      .send({ model: 'oa', messages: [{ role: 'user', content: 'x' }], response_format: format });
    assert.equal(res.status, 200);
    assert.equal(res.body.choices[0].message.content, 'not json');
    assert.equal(requests.length, 1);
  });

  it("returns Anthropic's forced json tool call as message.content", async () => {
    const { app } = setup([anthropicJson({ risk: 'low' })]);
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'an', messages: [{ role: 'user', content: 'x' }], response_format: format });
    assert.equal(res.status, 200);
    assert.equal(res.body.choices[0].message.content, '{"risk":"low"}');
    assert.equal(res.body.choices[0].message.tool_calls, undefined);
    assert.equal(res.body.choices[0].finish_reason, 'stop');
  });

  it('streams the Anthropic answer as content deltas', async () => {
    const { app } = setup([anthropicJson({ risk: 'high' })]);
    const res = await request(app)
      .post(CHAT)
      .send({
        model: 'an',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
        response_format: format
      });
    const frames = dataFrames(res.text);
    const text = frames
      .filter(f => f !== '[DONE]')
      .map(f => f.choices?.[0]?.delta?.content || '')
      .join('');
    assert.equal(text, '{"risk":"high"}');
    assert.ok(!frames.some(f => f.choices?.[0]?.delta?.tool_calls), 'no tool call on the wire');
    assert.equal(frames[frames.length - 1], '[DONE]');
  });

  it('ends a stream whose answer does not validate with an in-band error', async () => {
    const { app } = setup([openaiText(['{"risk":"meh"}'])]);
    const res = await request(app)
      .post(CHAT)
      .send({
        model: 'oa',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
        response_format: format
      });
    const frames = dataFrames(res.text);
    const error = frames.find(f => f?.error);
    assert.equal(error.error.code, 'output_validation_failed');
    assert.equal(frames[frames.length - 1], '[DONE]');
  });

  it('refuses structured output on a model that cannot do it, and prompt on a plain model', async () => {
    const { app, requests } = setup([]);
    const refused = await request(app)
      .post(CHAT)
      .send({
        model: 'ia',
        messages: [{ role: 'user', content: 'x' }],
        response_format: { type: 'json_object' }
      });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'structured_output_not_supported');
    const prompt = await request(app)
      .post(CHAT)
      .send({ model: 'oa', messages: [{ role: 'user', content: 'x' }], prompt: { variables: {} } });
    assert.equal(prompt.status, 400);
    assert.equal(prompt.body.code, 'prompt_requires_app');
    assert.equal(requests.length, 0);
  });
});

// ── /chat/completions, apps ─────────────────────────────────────────────────

describe('POST /chat/completions with an app', () => {
  it('runs the app on its preferred model, template on the last user message only', async () => {
    const { app, requests } = setup([openaiText(['done'], { usage })]);
    const res = await request(app)
      .post(CHAT)
      .send({
        model: 'app:summarizer',
        messages: [
          { role: 'user', content: 'earlier' },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'the text' }
        ],
        prompt: { variables: { action: 'translate', max_points: 3, 'document-id': 'D1' } }
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.model, 'app:summarizer/oa');
    assert.equal(res.body.choices[0].message.content, 'done');
    assert.equal(res.body.usage.total_tokens, 14);
    const sent = sentMessages(requests[0]);
    assert.match(systemOf(requests[0]), /SYS doc=D1 action=translate/);
    assert.equal(sent.find(m => m.role === 'user').content, 'earlier', 'history as sent');
    assert.equal(lastUserOf(requests[0]), 'TPL[translate|3]: the text');
  });

  it('echoes an explicitly chosen model and applies defaults', async () => {
    const { app, requests } = setup([openaiText(['ok'])]);
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'app:summarizer/oa2', messages: [{ role: 'user', content: 'go' }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.model, 'app:summarizer/oa2');
    assert.equal(requests[0].body.model, 'gpt-4.1');
    assert.equal(lastUserOf(requests[0]), 'TPL[summarize|]: go');
  });

  it('refuses what the app configuration owns', async () => {
    const { app, requests } = setup([]);
    const cases = [
      [
        {
          model: 'app:summarizer',
          messages: [
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' }
          ]
        },
        400,
        'system_message_not_allowed'
      ],
      [
        {
          model: 'app:nda',
          messages: [{ role: 'user', content: 'u' }],
          response_format: { type: 'json_object' }
        },
        400,
        'response_format_not_allowed'
      ],
      [
        {
          model: 'app:summarizer',
          messages: [{ role: 'user', content: 'u' }],
          prompt: { variables: { nope: 1 } }
        },
        400,
        'invalid_prompt_variables'
      ],
      [
        {
          model: 'app:summarizer',
          messages: [{ role: 'user', content: 'u' }],
          prompt: { id: 'nda' }
        },
        400,
        'prompt_id_mismatch'
      ],
      [
        { model: 'app:locked/oa2', messages: [{ role: 'user', content: 'u' }] },
        400,
        'model_selection_disabled'
      ],
      [
        { model: 'app:summarizer/ia', messages: [{ role: 'user', content: 'u' }] },
        400,
        'model_not_allowed_for_app'
      ],
      [{ model: 'app:missing', messages: [{ role: 'user', content: 'u' }] }, 404, 'app_not_found']
    ];
    for (const [body, status, code] of cases) {
      const res = await request(app).post(CHAT).send(body);
      assert.equal(res.status, status, `${code}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, code);
    }
    const unknown = await request(app)
      .post(CHAT)
      .send({
        model: 'app:summarizer',
        messages: [{ role: 'user', content: 'u' }],
        prompt: { variables: { nope: 1 } }
      });
    assert.deepEqual(unknown.body.details, [
      {
        variable: 'nope',
        code: 'unknown_variable',
        message: "app summarizer has no variable 'nope'"
      }
    ]);
    assert.equal(requests.length, 0, 'no model call for a refused request');
  });

  it("validates the app's output schema, retrying inside the run", async () => {
    const { app, requests } = setup([
      openaiText(['{"risk":"medium"}']),
      openaiText(['```json\n{"risk":"low"}\n```'])
    ]);
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'app:nda', messages: [{ role: 'user', content: 'contract' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.choices[0].message.content, '{"risk":"low"}', 'fences stripped');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body.responseSchema, RISK_SCHEMA);
    assert.match(systemOf(requests[0]), /The JSON must match this schema/);
    assert.match(lastUserOf(requests[1]), /does not match the required output format/);
  });

  it('retries an empty answer with a placeholder in its place', async () => {
    const { app, requests } = setup([openaiText([]), openaiText(['{"risk":"low"}'])]);
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'app:nda', messages: [{ role: 'user', content: 'contract' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const retry = sentMessages(requests[1]);
    assert.deepEqual(retry[retry.length - 2], { role: 'assistant', content: '(no answer)' });
  });

  it('answers 422 when the app output never validates', async () => {
    const { app } = setup([openaiText(['{"risk":"x"}']), openaiText(['{"risk":"y"}'])]);
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'app:nda', messages: [{ role: 'user', content: 'contract' }] });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'output_validation_failed');
    assert.equal(res.body.details[0].path, '/risk');
  });

  it('streams an app answer as chat.completion chunks', async () => {
    const { app } = setup([openaiText(['Hel', 'lo'], { usage })]);
    const res = await request(app)
      .post(CHAT)
      .send({
        model: 'app:summarizer',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'go' }]
      });
    const frames = dataFrames(res.text);
    assert.equal(frames[0].choices[0].delta.role, 'assistant');
    assert.equal(frames[0].model, 'app:summarizer/oa');
    const text = frames
      .filter(f => f !== '[DONE]')
      .map(f => f.choices?.[0]?.delta?.content || '')
      .join('');
    assert.equal(text, 'Hello');
    assert.equal(frames.find(f => f.choices?.[0]?.finish_reason).choices[0].finish_reason, 'stop');
    assert.equal(frames.find(f => f.usage).usage.total_tokens, 14);
    assert.equal(frames[frames.length - 1], '[DONE]');
  });
});

// ── /responses ──────────────────────────────────────────────────────────────

describe('POST /responses (stateless)', () => {
  it('returns the validated JSON of an app as a message with parsed output', async () => {
    const { app } = setup([openaiText(['{"risk":"high"}'], { usage })]);
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:nda', input: 'Analyze this NDA' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.object, 'response');
    assert.equal(res.body.status, 'completed');
    assert.equal(res.body.model, 'app:nda/oa');
    assert.equal(res.body.conversation, null);
    assert.equal(res.body.text.format.type, 'json_schema');
    assert.equal(res.body.output.length, 1);
    const [message] = res.body.output;
    assert.equal(message.type, 'message');
    assert.equal(message.content[0].type, 'output_text');
    assert.equal(message.content[0].text, '{"risk":"high"}');
    assert.deepEqual(message.content[0].parsed, { risk: 'high' });
    assert.deepEqual(res.body.usage, {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 14
    });
  });

  it('streams semantic events; a rejected attempt is closed and left out of the final output', async () => {
    const { app } = setup([openaiText(['{"risk":', '"meh"}']), openaiText(['{"risk":"low"}'])]);
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:nda', input: 'Analyze', stream: true });
    assert.match(res.headers['content-type'], /text\/event-stream/);
    const events = responseEvents(res.text);
    const types = events.map(e => e.type);
    assert.equal(types[0], 'response.created');
    assert.equal(types[1], 'response.in_progress');
    assert.equal(types[types.length - 1], 'response.completed');
    assert.deepEqual(
      events.map(e => e.sequence_number),
      events.map((_, i) => i),
      'sequence numbers count up from 0'
    );
    const itemsDone = events.filter(e => e.type === 'response.output_item.done');
    assert.equal(itemsDone[0].item.status, 'incomplete', 'the rejected attempt');
    assert.equal(itemsDone[1].item.status, 'completed');
    const deltas = events.filter(e => e.type === 'response.output_text.delta');
    assert.equal(
      deltas
        .filter(d => d.item_id === itemsDone[1].item.id)
        .map(d => d.delta)
        .join(''),
      '{"risk":"low"}'
    );
    const completed = events[events.length - 1].response;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.length, 1);
    assert.deepEqual(completed.output[0].content[0].parsed, { risk: 'low' });
  });

  it('reports a failed validation as response.failed when streaming, 422 otherwise', async () => {
    const streamed = setup([openaiText(['x']), openaiText(['y'])]);
    const res = await request(streamed.app)
      .post(RESPONSES)
      .send({ model: 'app:nda', input: 'Analyze', stream: true });
    const events = responseEvents(res.text);
    const failed = events[events.length - 1];
    assert.equal(failed.type, 'response.failed');
    assert.equal(failed.response.status, 'failed');
    assert.equal(failed.response.error.code, 'output_validation_failed');

    const plain = setup([openaiText(['x']), openaiText(['y'])]);
    const json = await request(plain.app)
      .post(RESPONSES)
      .send({ model: 'app:nda', input: 'Analyze' });
    assert.equal(json.status, 422);
    assert.equal(json.body.error.code, 'output_validation_failed');
    assert.equal(json.body.error.type, 'invalid_request_error');
  });

  it("reports the app's server-side tool calls as ihub_tool_call items", async () => {
    const { app, requests } = setup([
      toolCallTurn('lookup', { key: 'K-7' }),
      openaiText(['Found it.'])
    ]);
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:agent', input: 'find K-7', stream: true });
    const events = responseEvents(res.text);
    const added = events.find(
      e => e.type === 'response.output_item.added' && e.item.type === 'ihub_tool_call'
    );
    assert.equal(added.item.name, 'lookup');
    assert.equal(added.item.status, 'in_progress');
    assert.deepEqual(JSON.parse(added.item.arguments), { key: 'K-7' });
    const done = events.find(
      e => e.type === 'response.output_item.done' && e.item.type === 'ihub_tool_call'
    );
    assert.equal(done.item.status, 'completed');
    assert.match(done.item.output, /K-7/);
    const completed = events[events.length - 1].response;
    assert.deepEqual(
      completed.output.map(item => item.type),
      ['ihub_tool_call', 'message']
    );
    assert.equal(completed.output[1].content[0].text, 'Found it.');
    assert.ok(
      !events.some(e => e.item?.type === 'function_call'),
      'nothing asks the caller to execute a tool'
    );
    // The model got the tool result on the second call.
    assert.equal(requests.length, 2);
    assert.ok(sentMessages(requests[1]).some(m => m.role === 'tool'));
  });

  it("validates a tool-using app's final answer, not the prose before its tool call", async () => {
    const { app, requests } = setup([
      toolCallTurn('lookup', { key: 'K-7' }, 'call_1', 'Looking up {K-7} first.'),
      openaiText(['{"risk":"low"}'])
    ]);
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:auditor', input: 'rate K-7' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const message = res.body.output.find(item => item.type === 'message');
    assert.equal(message.content[0].text, '{"risk":"low"}');
    assert.deepEqual(message.content[0].parsed, { risk: 'low' });
    // Valid on the first answer: no corrected attempt was asked for.
    assert.equal(requests.length, 2);
  });

  it('runs a plain model with instructions and text.format', async () => {
    const { app, requests } = setup([openaiText(['{"risk":"low"}'])]);
    const res = await request(app)
      .post(RESPONSES)
      .send({
        model: 'oa',
        instructions: 'You rate risk.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'rate' }] }],
        text: { format: { type: 'json_schema', name: 'risk', schema: RISK_SCHEMA, strict: true } }
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.model, 'oa');
    assert.equal(res.body.instructions, 'You rate risk.');
    assert.deepEqual(res.body.output[0].content[0].parsed, { risk: 'low' });
    assert.deepEqual(sentMessages(requests[0])[0], { role: 'system', content: 'You rate risk.' });
    assert.deepEqual(requests[0].body.responseSchema, RISK_SCHEMA);
  });

  it('refuses the parts of the API it does not implement', async () => {
    const { app, requests } = setup([]);
    const cases = [
      [{ model: 'oa', input: 'x', previous_response_id: 'resp_1' }, 'unsupported_parameter'],
      [{ model: 'oa', input: 'x', background: true }, 'unsupported_parameter'],
      [{ model: 'oa', input: 'x', tools: [{ type: 'web_search' }] }, 'unsupported_parameter'],
      [{ model: 'oa', input: 'x', prompt: { id: 'p' } }, 'prompt_requires_app'],
      [{ model: 'app:nda', input: 'x', instructions: 'y' }, 'instructions_not_allowed'],
      [
        { model: 'app:nda', input: 'x', text: { format: { type: 'json_object' } } },
        'text_format_not_allowed'
      ],
      [
        { model: 'oa', input: [{ type: 'function_call_output', call_id: 'c' }] },
        'unsupported_input_item'
      ],
      [{ model: 'oa' }, 'missing_input']
    ];
    for (const [body, code] of cases) {
      const res = await request(app).post(RESPONSES).send(body);
      assert.equal(res.status, 400, `${code}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, code);
    }
    assert.equal(requests.length, 0);
  });
});

// ── /conversations ──────────────────────────────────────────────────────────

describe('conversations', () => {
  it('create → responses → items: templates, variables and history across turns', async () => {
    const { app, requests } = setup([
      openaiText(['first answer']),
      openaiText(['second answer']),
      openaiText(['third answer'])
    ]);
    const created = await request(app)
      .post(CONVERSATIONS)
      .send({ metadata: { ticket: 'T-1' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.object, 'conversation');
    assert.deepEqual(created.body.metadata, { ticket: 'T-1' });
    const conversation = created.body.id;

    // First turn: wrapped in the template, with this turn's variables.
    const first = await request(app)
      .post(RESPONSES)
      .send({
        model: 'app:summarizer',
        conversation,
        input: 'first',
        prompt: { variables: { action: 'translate', 'document-id': 'D1' } }
      });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.conversation, { id: conversation });
    assert.equal(lastUserOf(requests[0]), 'TPL[translate|]: first');
    assert.match(systemOf(requests[0]), /doc=D1 action=translate/);

    // Follow-up without variables: raw input, history as rendered, system
    // prompt still on the variables the first turn set.
    const second = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:summarizer', conversation: { id: conversation }, input: 'second' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const replay = sentMessages(requests[1]).filter(m => m.role !== 'system');
    assert.deepEqual(
      replay.map(m => [m.role, m.content]),
      [
        ['user', 'TPL[translate|]: first'],
        ['assistant', 'first answer'],
        ['user', 'second']
      ]
    );
    assert.match(systemOf(requests[1]), /doc=D1 action=translate/);

    // Follow-up with variables: wrapped again, with exactly these.
    const third = await request(app)
      .post(RESPONSES)
      .send({
        model: 'app:summarizer/oa2',
        conversation,
        input: 'third',
        prompt: { variables: { action: 'summarize', 'document-id': 'D2' } }
      });
    assert.equal(third.status, 200, JSON.stringify(third.body));
    assert.equal(third.body.model, 'app:summarizer/oa2', 'the real model may change between turns');
    assert.equal(lastUserOf(requests[2]), 'TPL[summarize|]: third');
    assert.match(systemOf(requests[2]), /doc=D2 action=summarize/);

    const items = await request(app).get(`${CONVERSATIONS}/${conversation}/items?order=asc`);
    assert.equal(items.status, 200);
    assert.equal(items.body.object, 'list');
    assert.deepEqual(
      items.body.data.map(item => [item.role, item.content[0].text]),
      [
        ['user', 'first'],
        ['assistant', 'first answer'],
        ['user', 'second'],
        ['assistant', 'second answer'],
        ['user', 'third'],
        ['assistant', 'third answer']
      ]
    );
    assert.equal(items.body.data[0].metadata.variables.action, 'translate');
    assert.equal(items.body.data[2].metadata, undefined, 'the follow-up carried no variables');
    assert.equal(items.body.data[1].metadata.model, 'app:summarizer/oa');
    assert.equal(items.body.data[5].metadata.model, 'app:summarizer/oa2');

    const page = await request(app).get(`${CONVERSATIONS}/${conversation}/items?limit=2`);
    assert.deepEqual(
      page.body.data.map(item => item.content[0].text),
      ['third answer', 'third'],
      'newest first by default'
    );
    assert.equal(page.body.has_more, true);
    const next = await request(app).get(
      `${CONVERSATIONS}/${conversation}/items?limit=2&after=${page.body.last_id}`
    );
    assert.deepEqual(
      next.body.data.map(item => item.content[0].text),
      ['second answer', 'second']
    );

    // An iHub chat of the caller: in their history, with its origin recorded.
    const chat = await getChatRepository().getChat(conversation);
    assert.equal(chat.ownerId, ADA.id);
    assert.equal(chat.appId, 'summarizer');
    assert.equal(chat.binding, 'app');
    assert.equal(chat.origin.createdVia, 'responses-api');
    assert.equal(chat.status, 'active');
    assert.equal(chat.activeRunId, null);
    const listed = await getChatRepository().listChats(ADA.id);
    assert.ok(listed.items.some(entry => entry.id === conversation));
  });

  it('stores the structured output of each answer and returns it as parsed', async () => {
    const { app } = setup([openaiText(['{"risk":"high"}'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:nda', conversation: conv.id, input: 'contract' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const items = await request(app).get(`${CONVERSATIONS}/${conv.id}/items?order=asc`);
    assert.deepEqual(items.body.data[1].content[0].parsed, { risk: 'high' });
    const stored = (await getChatRepository().getMessages(conv.id)).messages;
    assert.deepEqual(stored[1].output, { risk: 'high' });
    assert.equal(stored[1].model, 'app:nda/oa');
  });

  it('binds to the first app, refuses concurrent turns, and is private to its owner', async () => {
    const { app, as } = setup([openaiText(['ok'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    await request(app)
      .post(RESPONSES)
      .send({ model: 'app:summarizer', conversation: conv.id, input: 'hi' });

    const other = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:nda', conversation: conv.id, input: 'hi' });
    assert.equal(other.status, 400);
    assert.equal(other.body.error.code, 'conversation_app_mismatch');

    // A turn that just claimed the chat and is still running.
    const repository = getChatRepository();
    const claim = await repository.claimRun(conv.id, 'chat-11111111-1111-4111-8111-111111111111');
    assert.equal(claim.claimed, true);
    const busy = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:summarizer', conversation: conv.id, input: 'again' });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'conversation_busy');
    await repository.releaseRun(conv.id, 'chat-11111111-1111-4111-8111-111111111111', {
      activeRunId: null,
      status: 'active'
    });

    as(GRACE);
    const foreign = await request(app).get(`${CONVERSATIONS}/${conv.id}`);
    assert.equal(foreign.status, 404);
    const foreignTurn = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:summarizer', conversation: conv.id, input: 'x' });
    assert.equal(foreignTurn.status, 404);
    assert.equal(foreignTurn.body.error.code, 'conversation_not_found');
  });

  it('continues a plain-model conversation and keeps it off apps', async () => {
    const { app, requests } = setup([openaiText(['one']), openaiText(['two'])]);
    const { body: conv } = await request(app)
      .post(CONVERSATIONS)
      .send({
        items: [{ type: 'message', role: 'user', content: 'seeded' }]
      });
    await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', conversation: conv.id, instructions: 'Be brief.', input: 'q1' });
    const second = await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', conversation: conv.id, input: 'q2' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(
      sentMessages(requests[1]).map(m => [m.role, m.content]),
      [
        ['user', 'seeded'],
        ['user', 'q1'],
        ['assistant', 'one'],
        ['user', 'q2']
      ],
      'instructions apply to their own call only'
    );
    const toApp = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:summarizer', conversation: conv.id, input: 'x' });
    assert.equal(toApp.body.error.code, 'conversation_app_mismatch');
    const chat = await getChatRepository().getChat(conv.id);
    assert.equal(chat.binding, 'model');
    assert.equal(chat.modelId, 'oa');
  });

  it('updates metadata, adds and removes items, and deletes the conversation', async () => {
    const { app } = setup([]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const updated = await request(app)
      .post(`${CONVERSATIONS}/${conv.id}`)
      .send({ metadata: { stage: 'review' } });
    assert.deepEqual(updated.body.metadata, { stage: 'review' });

    const added = await request(app)
      .post(`${CONVERSATIONS}/${conv.id}/items`)
      .send({
        items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] },
          { type: 'message', role: 'assistant', content: 'b' }
        ]
      });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.data.length, 2);
    const itemId = added.body.data[0].id;
    const one = await request(app).get(`${CONVERSATIONS}/${conv.id}/items/${itemId}`);
    assert.equal(one.body.content[0].text, 'a');

    const removed = await request(app).delete(`${CONVERSATIONS}/${conv.id}/items/${itemId}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.object, 'conversation');
    const left = await request(app).get(`${CONVERSATIONS}/${conv.id}/items`);
    assert.deepEqual(
      left.body.data.map(item => item.content[0].text),
      ['b']
    );

    const deleted = await request(app).delete(`${CONVERSATIONS}/${conv.id}`);
    assert.deepEqual(deleted.body, { id: conv.id, object: 'conversation.deleted', deleted: true });
    const gone = await request(app).get(`${CONVERSATIONS}/${conv.id}`);
    assert.equal(gone.status, 404);
  });

  it('runs a follow-up without variables on the ones the conversation has', async () => {
    const { app, requests } = setup([openaiText(['one']), openaiText(['two'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const missing = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:docs', conversation: conv.id, input: 'summarize' });
    assert.equal(missing.status, 400, 'the first turn has to set the required variable');
    assert.equal(missing.body.error.details[0].code, 'missing_required');

    await request(app)
      .post(RESPONSES)
      .send({
        model: 'app:docs',
        conversation: conv.id,
        input: 'summarize',
        prompt: { variables: { 'document-id': 'DOC-9' } }
      });
    const followUp = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:docs', conversation: conv.id, input: 'and the risks?' });
    assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
    assert.match(systemOf(requests[1]), /Work on document DOC-9\./);
    assert.equal(lastUserOf(requests[1]), 'and the risks?');
  });

  it("keeps the conversation's variables where the chat UI keeps them", async () => {
    const { app, requests } = setup([openaiText(['one']), openaiText(['two'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    await request(app)
      .post(RESPONSES)
      .send({
        model: 'app:docs',
        conversation: conv.id,
        input: 'summarize',
        prompt: { variables: { 'document-id': 'DOC-9' } }
      });
    const repository = getChatRepository();
    assert.deepEqual((await repository.getChat(conv.id)).variables, { 'document-id': 'DOC-9' });

    // A start form in the chat UI replaces the set; the next API turn runs on it.
    await repository.updateChat(conv.id, { variables: { 'document-id': 'DOC-UI' } });
    const followUp = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:docs', conversation: conv.id, input: 'and the risks?' });
    assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
    assert.match(systemOf(requests[1]), /Work on document DOC-UI\./);
  });

  it('stores earlier input items with the documents they carried', async () => {
    const { app, requests } = setup([openaiText(['ok'])]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const text = Buffer.from('Clause 7: liability capped').toString('base64');
    const res = await request(app)
      .post(RESPONSES)
      .send({
        model: 'app:summarizer',
        conversation: conv.id,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Here is the contract.' },
              { type: 'input_file', filename: 'c.txt', file_data: `data:text/plain;base64,${text}` }
            ]
          },
          { role: 'user', content: 'Summarize it.' }
        ]
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(
      sentMessages(requests[0]).find(m => m.role === 'user').content,
      /liability capped/
    );
    const [earlier] = (await getChatRepository().getMessages(conv.id)).messages;
    assert.equal(earlier.content, 'Here is the contract.');
    assert.match(earlier.renderedContent, /liability capped/);
    assert.equal(earlier.attachments[0].name, 'c.txt');
  });

  it('refuses a turn whose conversation changed while it was prepared', async () => {
    let conversationId = null;
    const { app, requests } = setup([], {
      onPrepare: async () => {
        await getChatRepository().appendMessage(conversationId, {
          role: 'user',
          content: 'written by a concurrent turn'
        });
      }
    });
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    conversationId = conv.id;
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:summarizer', conversation: conv.id, input: 'mine' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'conversation_busy');
    assert.equal(requests.length, 0, 'no model call');
    const chat = await getChatRepository().getChat(conv.id);
    assert.equal(chat.activeRunId, null, 'the claim was given back');
    const stored = (await getChatRepository().getMessages(conv.id)).messages;
    assert.deepEqual(
      stored.map(m => m.content),
      ['written by a concurrent turn'],
      'nothing of the refused turn was stored'
    );
  });

  it('lets Stop abort a plain-model conversation turn, which the SDKs must not retry', async () => {
    let chatId;
    const { app } = setup([
      (_req, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(ctx.signal.reason || new Error('aborted'))
          );
          // The turn is running: stop it the way the chat's Stop button does.
          setTimeout(() => abortChatRequest(chatId), 20);
        })
    ]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    chatId = conv.id;
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', conversation: conv.id, input: 'long job' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'turn_aborted');
    assert.equal(res.headers['x-should-retry'], 'false');
    const chat = await getChatRepository().getChat(conv.id);
    assert.equal(chat.activeRunId, null);
    const stored = (await getChatRepository().getMessages(conv.id)).messages;
    assert.equal(stored[1].error.code, 'ABORTED');
  });

  it('tells the SDKs not to repeat a conversation turn that failed after it was stored', async () => {
    // Not a status the loop retries itself, so one scripted reply is enough.
    const failing = () => textResponse('bad request upstream', { status: 400 });
    const stateless = setup([failing]);
    const once = await request(stateless.app).post(RESPONSES).send({ model: 'oa', input: 'x' });
    assert.equal(once.status, 400);
    assert.equal(once.headers['x-should-retry'], undefined, 'nothing stored: retrying is safe');

    const { app } = setup([failing]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:summarizer', conversation: conv.id, input: 'x' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.headers['x-should-retry'], 'false');
  });

  it('needs chat persistence and a signed-in caller', async () => {
    const { app, as } = setup([]);
    configCache.setCacheEntry('config/platform.json', { chats: { enabled: false } });
    try {
      const off = await request(app).post(CONVERSATIONS).send({});
      assert.equal(off.status, 503);
      assert.equal(off.body.error.code, 'conversations_unavailable');
    } finally {
      configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
    }
    as({ id: 'anonymous', permissions: { apps: new Set(['*']), models: new Set(['*']) } });
    const anon = await request(app).post(CONVERSATIONS).send({});
    assert.equal(anon.status, 401);
  });
});

test('ledger records a rejected attempt as a recoverable error and the retry as a nudge', async () => {
  const events = [];
  const unsubscribe = ledger.runLog.subscribeAll(event => events.push(event));
  try {
    const { app } = setup([openaiText(['{"risk":"meh"}']), openaiText(['{"risk":"low"}'])]);
    const res = await request(app).post(RESPONSES).send({ model: 'app:nda', input: 'x' });
    assert.equal(res.status, 200);
  } finally {
    unsubscribe?.();
  }
  const error = events.find(e => e.type === 'error' && e.data.code === 'OUTPUT_VALIDATION_FAILED');
  assert.ok(error, 'validation failure on the ledger');
  assert.equal(error.data.recoverable, true);
  const nudge = events.find(e => e.type === 'message/user' && e.data.synthetic === 'nudge');
  assert.match(nudge.data.content, /does not match the required output format/);
});

test('ledger closes the run of a model response its conversation refused', async () => {
  const events = [];
  const unsubscribe = ledger.runLog.subscribeAll(event => events.push(event));
  const busyRun = 'chat-22222222-2222-4222-8222-222222222222';
  try {
    const { app } = setup([]);
    const { body: conv } = await request(app).post(CONVERSATIONS).send({});
    const repository = getChatRepository();
    assert.equal((await repository.claimRun(conv.id, busyRun)).claimed, true);
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', conversation: conv.id, input: 'hi' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'conversation_busy');
    await repository.releaseRun(conv.id, busyRun, { activeRunId: null, status: 'active' });
  } finally {
    unsubscribe?.();
  }
  const started = events.filter(e => e.type === RUN_LOG_EVENTS.RUN_START).map(e => e.runId);
  assert.equal(started.length, 1, 'the response opened one run');
  const end = events.find(e => e.runId === started[0] && e.type === RUN_LOG_EVENTS.RUN_END);
  assert.ok(end, 'and closed it');
  assert.equal(end.data.status, 'error');
});
