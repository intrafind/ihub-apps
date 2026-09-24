/**
 * Model discovery remembers failures: an unreachable OpenAI-compatible endpoint
 * used to cost every message the full discovery timeout (and a blocking DNS
 * lookup) before the completion request even started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import modelDiscoveryService from '../services/ModelDiscoveryService.js';

const model = {
  id: 'test-discovery-model',
  modelId: 'configured-model',
  provider: 'openai',
  autoDiscovery: true,
  url: 'http://vllm.corp.test:8080/v1/chat/completions'
};

test('a failed discovery is remembered and the configured modelId is used without a new probe', async () => {
  modelDiscoveryService.clearCache(model.id);
  let probes = 0;
  const original = modelDiscoveryService._performDiscovery;
  // Simulate the real failure path's bookkeeping without a network call.
  modelDiscoveryService._performDiscovery = async m => {
    probes++;
    return modelDiscoveryService._rememberFailure(m.id);
  };
  try {
    assert.equal(await modelDiscoveryService.getEffectiveModelId(model, 'k'), 'configured-model');
    assert.equal(await modelDiscoveryService.getEffectiveModelId(model, 'k'), 'configured-model');
    assert.equal(probes, 1, 'the second call is served from the failure cache');
    const entry = modelDiscoveryService.cache.get(model.id);
    assert.equal(entry.modelId, null);
    assert.equal(entry.ttlMs, modelDiscoveryService.FAILURE_CACHE_TTL_MS);
  } finally {
    modelDiscoveryService._performDiscovery = original;
    modelDiscoveryService.clearCache(model.id);
  }
});

test('an expired failure entry triggers a fresh probe', async () => {
  modelDiscoveryService.clearCache(model.id);
  modelDiscoveryService.cache.set(model.id, {
    modelId: null,
    timestamp: Date.now() - modelDiscoveryService.FAILURE_CACHE_TTL_MS - 1,
    ttlMs: modelDiscoveryService.FAILURE_CACHE_TTL_MS
  });
  let probes = 0;
  const original = modelDiscoveryService._performDiscovery;
  modelDiscoveryService._performDiscovery = async () => {
    probes++;
    return 'discovered-model';
  };
  try {
    assert.equal(await modelDiscoveryService.getEffectiveModelId(model, 'k'), 'discovered-model');
    assert.equal(probes, 1);
  } finally {
    modelDiscoveryService._performDiscovery = original;
    modelDiscoveryService.clearCache(model.id);
  }
});

test('a discovery reads max_model_len and serves it as the context window', async () => {
  // Real HTTP rather than a fetch stub: the service fetches through
  // requestThrottler/httpFetch, so a global fetch stub is never consulted.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'Qwen/Qwen3.6-35B-A3B-FP8', max_model_len: 173184 }]
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const served = {
    ...model,
    id: 'max-model-len-probe',
    url: `http://127.0.0.1:${port}/v1/chat/completions`
  };
  modelDiscoveryService.clearCache(served.id);
  try {
    assert.equal(
      await modelDiscoveryService.getEffectiveModelId(served, 'k'),
      'Qwen/Qwen3.6-35B-A3B-FP8'
    );
    assert.equal(modelDiscoveryService.getDiscoveredContextWindow(served.id), 173184);
  } finally {
    modelDiscoveryService.clearCache(served.id);
    await new Promise(resolve => server.close(resolve));
  }
});

test('the context window is null when unknown, unseen or stale', async () => {
  modelDiscoveryService.clearCache(model.id);
  // Never discovered.
  assert.equal(modelDiscoveryService.getDiscoveredContextWindow(model.id), null);

  // Endpoint did not report the field (OpenAI, LM Studio).
  modelDiscoveryService.cache.set(model.id, {
    modelId: 'gpt-4o',
    maxModelLen: null,
    timestamp: Date.now()
  });
  assert.equal(modelDiscoveryService.getDiscoveredContextWindow(model.id), null);

  // Stale entries are not served — the endpoint may be serving another model.
  modelDiscoveryService.cache.set(model.id, {
    modelId: 'whatever',
    maxModelLen: 173184,
    timestamp: Date.now() - modelDiscoveryService.DEFAULT_CACHE_TTL_MS - 1
  });
  assert.equal(modelDiscoveryService.getDiscoveredContextWindow(model.id), null);
  modelDiscoveryService.clearCache(model.id);
});

test('a configured contextWindow wins over the discovered one', async () => {
  const { chatCompactThresholdTokens } = await import('../services/chat/ChatService.js');
  modelDiscoveryService.clearCache(model.id);
  modelDiscoveryService.cache.set(model.id, {
    modelId: 'm',
    maxModelLen: 173184,
    timestamp: Date.now()
  });
  try {
    // Operators lower contextWindow deliberately; discovery must not raise it.
    assert.equal(chatCompactThresholdTokens({ id: model.id, contextWindow: 32768 }), 16384);
    // No configured window: fall back to what the endpoint reported.
    assert.equal(chatCompactThresholdTokens({ id: model.id }), Math.floor(173184 / 2));
    // Neither: the floor.
    assert.equal(chatCompactThresholdTokens({ id: 'unknown-model' }), 16000);
  } finally {
    modelDiscoveryService.clearCache(model.id);
  }
});
