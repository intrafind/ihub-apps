/**
 * Model discovery remembers failures: an unreachable OpenAI-compatible endpoint
 * used to cost every message the full discovery timeout (and a blocking DNS
 * lookup) before the completion request even started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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
