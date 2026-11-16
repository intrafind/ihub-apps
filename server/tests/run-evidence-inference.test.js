// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A `/v1/chat/completions` run has no chat, so it keeps its evidence record in
 * `run-evidence`, owned by the caller (#3687): for a plain model and an app,
 * and never for an anonymous caller.
 *
 * Run: node --test server/tests/run-evidence-inference.test.js
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
import { getStorage } from '../storage/bootstrap.js';
import { getChatEvidenceRepository } from '../services/chat/ChatEvidenceRepository.js';
import { evidenceWritesSettled, recordRunEvidence } from '../services/chat/evidenceRecord.js';
import { makeClient, sseResponse, openaiText, captureRunLog } from './loop/helpers/llmFixtures.js';

const MODELS = [
  {
    id: 'plain',
    provider: 'local',
    modelId: 'mistral-small',
    url: 'http://vllm.internal:8000/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    default: true
  }
];
const APPS = [
  {
    id: 'helper',
    name: { en: 'Helper' },
    system: { en: 'Be brief.' },
    preferredModel: 'plain',
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
});

function setup(user) {
  const { client } = makeClient({
    models: MODELS,
    runLog: ledger.runLog,
    realRequest: true,
    transport: async () => sseResponse(openaiText(['An answer.']))
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
    req.user = { ...user, permissions };
    next();
  });
  registerOpenAIProxyRoutes(app, {
    llmClient: client,
    chatService,
    getLocalizedError: async key => key,
    DEFAULT_TIMEOUT: 30000
  });
  return app;
}

/** The run evidence documents of one owner, waiting for the background write. */
async function recordsOf(ownerId, count) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const page = await getStorage().documents.list('run-evidence', { ownerId, limit: 100 });
    if (page.items.length >= count || Date.now() > deadline) return page.items;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('evidence of /v1/chat/completions runs', () => {
  it('records a plain model call and an app turn for the caller', async () => {
    const app = setup({ id: 'user-ada', name: 'Ada' });
    const runIds = [];
    for (const model of ['plain', 'app:helper']) {
      const res = await request(app)
        .post(CHAT)
        .send({ model, messages: [{ role: 'user', content: 'Hello' }] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.headers['x-run-id'], 'the run id is returned');
      runIds.push(res.headers['x-run-id']);
    }
    await evidenceWritesSettled();
    const records = await recordsOf('user-ada', 2);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(doc => doc.key).sort(), [...runIds].sort());
    for (const doc of records) {
      assert.equal(doc.data.runId, doc.key);
      assert.equal(doc.data.calls.length, 1);
      assert.equal(doc.data.calls[0].status, 'ok');
      const [message] = doc.data.calls[0].messages.append.slice(-1);
      const content = await getChatEvidenceRepository().getContent(
        'run',
        doc.key,
        doc.data,
        message.message.replace('sha256:', '')
      );
      assert.equal(JSON.parse(content.toString('utf8')).role, 'user');
    }
    const appRecord = records.find(doc => doc.data.app?.id === 'helper');
    assert.ok(appRecord, 'the app turn names its app');
    assert.equal(
      appRecord.data.calls[0].messages.append[0].role,
      'system',
      'with its system prompt'
    );
    assert.ok(appRecord.data.app.config, 'and the app configuration as stored');
  });

  it('records an answer the structured-output check rejected as an error', async () => {
    const app = setup({ id: 'user-bob', name: 'Bob' });
    const res = await request(app)
      .post(CHAT)
      .send({
        model: 'plain',
        messages: [{ role: 'user', content: 'Hello' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
          }
        }
      });
    assert.notEqual(res.status, 200, 'not JSON, so rejected');
    await evidenceWritesSettled();
    const doc = await getChatEvidenceRepository().getRecord('run', res.headers['x-run-id']);
    assert.equal(doc.data.status, 'error');
  });

  it('drops a record whose run was deleted before it was written', async () => {
    const { runId } = await ledger.runLog.startRun({ kind: 'inference', user: { id: 'user-cy' } });
    ledger.runLog.append(runId, 'request/header', {
      step: 0,
      requestId: 'r',
      model: 'plain',
      provider: 'local',
      requestHash: 'h',
      messagesHash: 'h',
      messageCount: 0,
      reason: 'initial',
      messages: [],
      toolSchemasHash: null
    });
    ledger.runLog.endRun(runId, { status: 'completed' });
    // The journal as the build read it, then the run is deleted before the write.
    const events = await ledger.runLog.readEvents(runId);
    await ledger.runLog.deleteRun(runId);
    // The build reads the journal as it was; the check under the lock reads it now.
    let built = false;
    const journal = {
      readEvents: async (id, options) => {
        if (built) return ledger.runLog.readEvents(id, options);
        built = true;
        return events;
      },
      readSpill: async () => null
    };
    await recordRunEvidence({ runId, user: { id: 'user-cy' }, runLog: journal });
    assert.equal(await getChatEvidenceRepository().getRecord('run', runId), null);
  });

  it('records nothing for an anonymous caller', async () => {
    const { runId } = await ledger.runLog.startRun({ kind: 'inference', user: null });
    assert.equal(
      await recordRunEvidence({ runId, user: { id: 'anonymous' }, runLog: ledger.runLog }),
      null
    );
    assert.equal(await getChatEvidenceRepository().getRecord('run', runId), null);
  });
});
