// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/models?type=`: chat models by default, and a comma-separated list
 * for the chat's model selector, which offers transcription models too.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import configCache from '../configCache.js';
import errorHandler from '../middleware/errorHandler.js';
import registerModelRoutes from '../routes/modelRoutes.js';
import { getLocalizedError } from '../serverHelpers.js';

const MODELS = [
  { id: 'gemini-flash', provider: 'google', url: 'https://chat.example', apiKey: 'secret' },
  {
    id: 'gemini-live',
    modelType: 'transcription',
    provider: 'google-live',
    url: 'wss://internal.example/live',
    apiKey: 'secret'
  },
  {
    id: 'gemini-batch',
    modelType: 'transcription',
    provider: 'google-transcribe',
    url: 'https://internal.example/batch'
  },
  { id: 'voxtral-tts', modelType: 'tts', provider: 'mistral' }
];

let savedGetModelsForUser;
let savedPlatform;

before(() => {
  savedGetModelsForUser = configCache.getModelsForUser;
  savedPlatform = configCache.cache.get('config/platform.json');
  configCache.getModelsForUser = async () => ({ data: MODELS, etag: 'models-etag' });
  configCache.cache.set('config/platform.json', {
    data: { auth: { mode: 'local' }, anonymousAuth: { enabled: true, defaultGroups: [] } },
    etag: 'p'
  });
});

after(() => {
  configCache.getModelsForUser = savedGetModelsForUser;
  if (savedPlatform === undefined) configCache.cache.delete('config/platform.json');
  else configCache.cache.set('config/platform.json', savedPlatform);
});

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'alice', permissions: { models: new Set(['*']) } };
    next();
  });
  registerModelRoutes(app, { getLocalizedError });
  app.use(errorHandler);
  return app;
}

const ids = res => res.body.items.map(m => m.id);

describe('GET /api/models?type=', () => {
  test('lists chat models by default', async () => {
    const res = await request(buildApp()).get('/api/models');
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res), ['gemini-flash']);
  });

  test('a list returns chat and transcription models, with their transcription mode', async () => {
    const res = await request(buildApp()).get('/api/models?type=chat,transcription');
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res), ['gemini-flash', 'gemini-live', 'gemini-batch']);
    const byId = Object.fromEntries(res.body.items.map(m => [m.id, m]));
    assert.equal(byId['gemini-live'].transcriptionMode, 'stream');
    assert.equal(byId['gemini-batch'].transcriptionMode, 'batch');
    assert.equal(byId['gemini-flash'].transcriptionMode, undefined);
    // Transcription endpoints and every key stay on the server.
    assert.equal(byId['gemini-live'].url, undefined);
    assert.equal(byId['gemini-live'].apiKey, undefined);
    assert.equal(byId['gemini-flash'].apiKey, undefined);
  });

  test('the list and the single type have distinct ETags', async () => {
    const app = buildApp();
    const chat = await request(app).get('/api/models');
    const both = await request(app).get('/api/models?type=transcription,chat');
    assert.notEqual(chat.headers.etag, both.headers.etag);
    const again = await request(app).get('/api/models?type=chat,transcription');
    assert.equal(again.headers.etag, both.headers.etag);
  });

  test('an ETag from before the { items } body is not answered 304', async () => {
    // The ETag the route sent while it answered a bare array: the config hash
    // and the type. A browser that cached that array revalidates with it after
    // the upgrade; a 304 would hand the client the array, and the start page
    // showed "No models available".
    const app = buildApp();
    const stale = await request(app).get('/api/models').set('If-None-Match', 'models-etag-chat');
    assert.equal(stale.status, 200);
    assert.deepEqual(ids(stale), ['gemini-flash']);
    // The current ETag still revalidates.
    const fresh = await request(app).get('/api/models').set('If-None-Match', stale.headers.etag);
    assert.equal(fresh.status, 304);
  });

  test('an unknown type in the list is a 400', async () => {
    const res = await request(buildApp()).get('/api/models?type=chat,video');
    assert.equal(res.status, 400);
    assert.match(res.body.detail, /Unknown model type: video/);
  });
});
