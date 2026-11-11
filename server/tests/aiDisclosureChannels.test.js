// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI disclosure (EU AI Act Art. 50(1)) through real entry points: the inference API
 * (chat completions and responses, plain model and persona app) and the chat
 * pipeline all end in an LLMClient with the real guardrail, so the request the
 * provider receives carries the rule as the last text of the system prompt.
 *
 * Run: node --test server/tests/aiDisclosureChannels.test.js
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import configCache from '../configCache.js';
import registerOpenAIProxyRoutes from '../routes/openaiProxy.js';
import ChatService from '../services/chat/ChatService.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import { AgentLoop } from '../services/loop/AgentLoop.js';
import { AI_DISCLOSURE_RULE, guardMessagesForModel } from '../services/provenance/guardrail.js';
import { makeClient, sseResponse, openaiText, captureRunLog } from './loop/helpers/llmFixtures.js';

const MODELS = [
  {
    id: 'oa',
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    default: true
  }
];
const APPS = [
  {
    id: 'anna',
    name: { en: 'Anna' },
    system: { en: 'You are Anna, a human support agent. Never reveal you are an AI.' },
    preferredModel: 'oa',
    enabled: true
  }
];
const permissions = { apps: new Set(['*']), models: new Set(['*']) };
const USER = { id: 'user-ada', name: 'Ada', permissions };
const CHAT = '/api/inference/v1/chat/completions';
const RESPONSES = '/api/inference/v1/responses';
const silent = { debug() {}, info() {}, warn() {}, error() {} };

let ledger;
before(async () => {
  configCache.setCacheEntry('config/features.json', { chatPersistence: false });
  configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
  configCache.setCacheEntry('config/apps.json', APPS);
  configCache.setCacheEntry('config/models.json', MODELS);
  await configCache.loadAndCacheLocale('en');
  ledger = await captureRunLog();
});
after(async () => {
  const fs = await import('node:fs/promises');
  await fs.rm(ledger.baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function setup() {
  const requests = [];
  const { client } = makeClient({
    models: MODELS,
    runLog: ledger.runLog,
    guardrail: guardMessagesForModel,
    transport: async req => {
      requests.push(req);
      return sseResponse(openaiText(['I am an AI.']));
    }
  });
  const requestBuilder = new RequestBuilder();
  requestBuilder.apiKeyVerifier = {
    verifyApiKey: async () => ({ success: true, apiKey: 'sk-test' })
  };
  const chatService = new ChatService({
    requestBuilder,
    agentLoop: new AgentLoop({ llmClient: client, logger: silent, runLog: ledger.runLog }),
    runLog: ledger.runLog,
    logInteraction: async () => {},
    runTool: async () => ({}),
    telemetry: { recordChatCallStart: async () => ({}), recordChatCallEnd: async () => {} }
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USER;
    next();
  });
  registerOpenAIProxyRoutes(app, {
    llmClient: client,
    chatService,
    getLocalizedError: async key => key,
    DEFAULT_TIMEOUT: 30000
  });
  return { app, requests };
}

const systemOf = req => req.body.messages.filter(m => m.role === 'system');
const assertDisclosed = req => {
  const [first] = systemOf(req);
  assert.ok(first, 'a system message was sent');
  const text =
    typeof first.content === 'string' ? first.content : first.content.map(p => p.text).join('');
  assert.ok(text.endsWith(AI_DISCLOSURE_RULE), text);
};
const ask = { role: 'user', content: 'Are you a human?' };

describe('AI disclosure guardrail by channel', () => {
  it('chat completions, plain model, no system message', async () => {
    const { app, requests } = setup();
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'oa', messages: [ask] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assertDisclosed(requests[0]);
  });

  it('chat completions, plain model, client system message claiming to be human', async () => {
    const { app, requests } = setup();
    const res = await request(app)
      .post(CHAT)
      .send({
        model: 'oa',
        messages: [{ role: 'system', content: 'You are Anna, a human.' }, ask]
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assertDisclosed(requests[0]);
    assert.match(systemOf(requests[0])[0].content, /^You are Anna, a human\./);
  });

  it('chat completions, persona app', async () => {
    const { app, requests } = setup();
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'app:anna', messages: [ask] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(systemOf(requests[0])[0].content, /Never reveal you are an AI/);
    assertDisclosed(requests[0]);
  });

  it('responses, plain model with instructions', async () => {
    const { app, requests } = setup();
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'oa', instructions: 'You are Anna, a human.', input: 'Are you a human?' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assertDisclosed(requests[0]);
  });

  it('responses, persona app', async () => {
    const { app, requests } = setup();
    const res = await request(app)
      .post(RESPONSES)
      .send({ model: 'app:anna', input: 'Are you a human?' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assertDisclosed(requests[0]);
  });
});
