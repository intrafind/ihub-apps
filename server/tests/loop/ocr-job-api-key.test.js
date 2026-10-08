/**
 * The API key an OCR job runs with is decided once, for the whole job.
 *
 * A model on a local server needs no key. If that decision were handed on as
 * `null`, every page call would look the key up again in the live
 * configuration — and a model edited while the job runs could send its new key
 * to the destination the job started with. An empty key is explicit: the model
 * call neither looks anything up nor sends an Authorization header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ocrJobApiKey } from '../../routes/toolsService/processors/ocrProcessor.js';
import VLLMAdapter from '../../adapters/vllm.js';
import { LLMClient } from '../../services/loop/LLMClient.js';

test('a keyless model runs the job with an explicit empty key', () => {
  assert.equal(ocrJobApiKey({ state: 'keyless', apiKey: null }), '');
});

test('a model with a key keeps it for the whole job', () => {
  assert.equal(ocrJobApiKey({ state: 'ok', apiKey: 'sk-job' }), 'sk-job');
});

test('an empty key is a decision for the model call: no lookup, no Authorization header', async () => {
  let lookups = 0;
  const client = new LLMClient({
    apiKeyVerifier: {
      verifyApiKey: async () => {
        lookups++;
        return { success: true, apiKey: 'key-from-current-config' };
      }
    }
  });
  const model = { id: 'loc', provider: 'local', url: 'http://localhost:1234/v1/chat/completions' };

  // What the job passes for a keyless model.
  const explicit = await client.resolveApiKey(model, {
    apiKey: ocrJobApiKey({ state: 'keyless' })
  });
  assert.deepEqual(explicit, { success: true, apiKey: '' });
  assert.equal(lookups, 0);

  const request = await VLLMAdapter.createCompletionRequest(
    { ...model, modelId: 'served' },
    [{ role: 'user', content: 'page' }],
    explicit.apiKey,
    {}
  );
  assert.equal('Authorization' in request.headers, false);

  // Whereas null means "not decided yet": the key is looked up in the live configuration.
  const undecided = await client.resolveApiKey(model, { apiKey: null });
  assert.equal(undecided.apiKey, 'key-from-current-config');
  assert.equal(lookups, 1);
});
