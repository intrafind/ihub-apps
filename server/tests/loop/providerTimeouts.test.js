// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where a transport ceiling comes from: model, provider entry, constructor,
 * platform.json, environment. Most specific wins; `0` on a level is a value
 * ("no ceiling"), not "unset".
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config.js';
import configCache from '../../configCache.js';
import { makeClient, sseResponse, openaiText } from './helpers/llmFixtures.js';

const messages = [{ role: 'user', content: 'hi' }];

const googleModel = { id: 'g', provider: 'google', modelId: 'gemini-pro-latest', url: 'https://x' };
const linkedModel = {
  id: 'hub',
  provider: 'openai',
  providerId: 'hub',
  modelId: 'm',
  url: 'https://x'
};

afterEach(() => {
  configCache.setCacheEntry('config/platform.json', {});
  configCache.setCacheEntry('config/providers.json', { providers: [] });
});

const setProviders = providers => configCache.setCacheEntry('config/providers.json', { providers });
const setPlatform = llm => configCache.setCacheEntry('config/platform.json', { llm });

test('a provider entry sets the ceiling for the models that take their key from it', () => {
  setProviders([{ id: 'google', streamIdleTimeoutMs: 180000, connectTimeoutMs: 45000 }]);
  const { client } = makeClient({ transport: () => {} });
  assert.equal(client._streamIdleTimeoutMsFor(googleModel), 180000);
  assert.equal(client._connectTimeoutMsFor(googleModel), 45000);
});

test('a custom provider is found by the model providerId, not its API type', () => {
  setProviders([
    { id: 'openai', streamIdleTimeoutMs: 1000 },
    { id: 'hub', streamIdleTimeoutMs: 120000 }
  ]);
  const { client } = makeClient({ transport: () => {} });
  assert.equal(client._streamIdleTimeoutMsFor(linkedModel), 120000);
});

test("a model's own value beats its provider's", () => {
  setProviders([{ id: 'google', streamIdleTimeoutMs: 180000 }]);
  const { client } = makeClient({ transport: () => {} });
  assert.equal(client._streamIdleTimeoutMsFor({ ...googleModel, streamIdleTimeoutMs: 5000 }), 5000);
});

test("a provider's value beats the platform's and the constructor's", () => {
  setPlatform({ streamIdleTimeoutMs: 90000 });
  setProviders([{ id: 'google', streamIdleTimeoutMs: 180000 }]);
  const { client } = makeClient({ streamIdleTimeoutMs: 70000, transport: () => {} });
  assert.equal(client._streamIdleTimeoutMsFor(googleModel), 180000);
});

test('a provider without the key leaves the platform value in charge', () => {
  setPlatform({ streamIdleTimeoutMs: 90000, connectTimeoutMs: 20000 });
  setProviders([{ id: 'google', connectTimeoutMs: 45000 }]);
  const { client } = makeClient({ transport: () => {} });
  assert.equal(client._streamIdleTimeoutMsFor(googleModel), 90000);
  assert.equal(client._connectTimeoutMsFor(googleModel), 45000);
});

test('a provider value of 0 disables the ceiling instead of falling through', () => {
  setPlatform({ streamIdleTimeoutMs: 90000 });
  setProviders([{ id: 'google', streamIdleTimeoutMs: 0 }]);
  const { client } = makeClient({ transport: () => {} });
  assert.equal(client._streamIdleTimeoutMsFor(googleModel), 0);
});

test('with nothing set anywhere the environment default applies', () => {
  const { client } = makeClient({ transport: () => {} });
  assert.equal(client._streamIdleTimeoutMsFor(googleModel), config.LLM_STREAM_IDLE_TIMEOUT_MS);
  assert.equal(client._connectTimeoutMsFor(googleModel), config.LLM_CONNECT_TIMEOUT_MS);
});

test('a change to the provider applies to the next call without rebuilding the client', () => {
  const { client } = makeClient({ transport: () => {} });
  setProviders([{ id: 'google', streamIdleTimeoutMs: 111 }]);
  assert.equal(client._streamIdleTimeoutMsFor(googleModel), 111);
  setProviders([{ id: 'google', streamIdleTimeoutMs: 222 }]);
  assert.equal(client._streamIdleTimeoutMsFor(googleModel), 222);
});

test('a call still completes normally under a provider ceiling', async () => {
  setProviders([{ id: 'openai', streamIdleTimeoutMs: 5000, connectTimeoutMs: 5000 }]);
  const { client } = makeClient({
    transport: () => sseResponse(openaiText(['ok']))
  });
  const stream = await client.execute({ modelId: 'oa', messages, timeoutMs: 10_000 });
  const result = await client.collect(stream);
  assert.equal(result.content, 'ok');
});
