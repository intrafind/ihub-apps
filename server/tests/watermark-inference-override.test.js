// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Acceptance (#3331): no client can switch the text watermark off. Whatever a
 * caller sends as `watermarking`, `extra_body` or the SDK-flattened top-level
 * form, the request vLLM receives carries `watermarking: true` for a model
 * marked `by: "ihub"` (streamed and not, plain model and app), and the returned
 * provenance object says the mark was applied with the active key id.
 *
 * Run: node --test server/tests/watermark-inference-override.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import configCache from '../configCache.js';
import registerOpenAIProxyRoutes from '../routes/openaiProxy.js';
import ChatService from '../services/chat/ChatService.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import { AgentLoop } from '../services/loop/AgentLoop.js';
import { setActiveKeyIdSnapshot } from '../services/provenance/watermark/activeKeySnapshot.js';
import { makeClient, sseResponse, openaiText, captureRunLog } from './loop/helpers/llmFixtures.js';

const MODELS = [
  {
    id: 'vl',
    provider: 'local',
    modelId: 'mistral-small',
    url: 'http://vllm.internal:8000/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    default: true,
    sampling: { temperature: 0.7 },
    contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } }
  },
  {
    id: 'plain',
    provider: 'local',
    modelId: 'mistral-small',
    url: 'http://vllm.internal:8000/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    sampling: { temperature: 0.7 }
  },
  {
    id: 'vl-greedy',
    provider: 'local',
    modelId: 'mistral-small',
    url: 'http://vllm.internal:8000/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    sampling: { temperature: 0 },
    contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } }
  }
];
const APPS = [
  {
    id: 'helper',
    name: { en: 'Helper' },
    system: { en: 'Be brief.' },
    preferredModel: 'vl',
    enabled: true
  }
];
const permissions = { apps: new Set(['*']), models: new Set(['*']) };
const CHAT = '/api/inference/v1/chat/completions';
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
  setActiveKeyIdSnapshot(null);
});
beforeEach(() => setActiveKeyIdSnapshot('wm-2026-1'));

function setup() {
  const requests = [];
  const { client } = makeClient({
    models: MODELS,
    runLog: ledger.runLog,
    realRequest: true,
    transport: async req => {
      requests.push(req);
      return sseResponse(openaiText(['A watermarked answer.']));
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
    req.user = { id: 'user-ada', name: 'Ada', permissions };
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

const ask = { role: 'user', content: 'Hello' };
const overrides = {
  'watermarking:false': { watermarking: false },
  'extra_body.watermarking:false': { extra_body: { watermarking: false } },
  'watermarking:null': { watermarking: null },
  'extra_body with a watermark config': {
    extra_body: { watermarking: false, watermark_config: { enforce: false } }
  }
};

describe('a client cannot switch the text watermark off', () => {
  for (const [name, extra] of Object.entries(overrides)) {
    for (const model of ['vl', 'app:helper']) {
      for (const stream of [false, true]) {
        it(`${name}, ${model}, stream=${stream}`, async () => {
          const { app, requests } = setup();
          const res = await request(app)
            .post(CHAT)
            .send({ model, messages: [ask], stream, ...extra });
          assert.equal(res.status, 200, res.text);
          assert.equal(requests.length, 1);
          assert.equal(requests[0].body.watermarking, true);
          assert.equal('extra_body' in requests[0].body, false);
          assert.equal('watermark_config' in requests[0].body, false);
          assert.equal('marking' in requests[0].body, false);
          // The key id is recorded, the key itself never sent.
          assert.doesNotMatch(JSON.stringify(requests[0].body), /wm-2026-1/);
          if (!stream) {
            assert.deepEqual(
              { ...res.body.provenance.model.watermark },
              { by: 'ihub', scheme: 'vllm-gumbel', key_id: 'wm-2026-1', applied: true }
            );
          }
        });
      }
    }
  }

  it('a greedy model is recorded as not applied, with the reason', async () => {
    const { app, requests } = setup();
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'vl-greedy', messages: [ask], stream: false });
    assert.equal(res.status, 200, res.text);
    assert.equal(requests[0].body.watermarking, true);
    assert.deepEqual(
      { ...res.body.provenance.model.watermark },
      { by: 'ihub', scheme: 'vllm-gumbel', applied: false, reason: 'greedy' }
    );
  });

  it('a model without ihub marking never gets the field, whatever the client asks', async () => {
    const { app, requests } = setup();
    const res = await request(app)
      .post(CHAT)
      .send({ model: 'plain', messages: [ask], stream: false, watermarking: true });
    assert.equal(res.status, 200, res.text);
    assert.equal('watermarking' in requests[0].body, false);
    assert.equal(res.body.provenance.model.watermark.by, 'none');
  });
});
