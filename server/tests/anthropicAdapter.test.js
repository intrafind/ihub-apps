// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import assert from 'assert';
import AnthropicAdapter from '../adapters/anthropic.js';
import logger from '../utils/logger.js';

const model = {
  modelId: 'claude-4-sonnet',
  url: 'https://api.anthropic.com/v1/messages',
  provider: 'anthropic'
};
const messages = [{ role: 'user', content: 'test' }];

const schema = { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] };
const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
  responseSchema: schema
});

const jsonTool = req.body.tools.find(t => t.name === 'json');
assert.ok(jsonTool, 'json tool added');
assert.deepStrictEqual(jsonTool.input_schema, schema);
assert.deepStrictEqual(req.body.tool_choice, { type: 'tool', name: 'json' });
assert.strictEqual(req.body.response_format, undefined);
logger.info('Anthropic adapter structured output test passed');

// --- Sampling parameters (issues #2282, #2883) ------------------------------
// Sampling only comes from the model config. Anthropic removed `temperature`
// from Claude Opus 5 / Sonnet 5 / Fable 5.x: sending it returns a 400 and the
// whole request fails. Those configs say `supportsTemperature: false`.
const unconfigured = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
  temperature: 0.4
});
for (const key of ['temperature', 'top_p', 'top_k']) {
  assert.ok(
    !(key in unconfigured.body),
    `${key} must be absent when the model sets no sampling, whatever the caller passes`
  );
}

const sampled = await AnthropicAdapter.createCompletionRequest(
  { ...model, sampling: { temperature: 0.4, topP: 0.9, topK: 40 } },
  messages,
  'key'
);
assert.strictEqual(sampled.body.temperature, 0.4, 'temperature from the model config');
assert.strictEqual(sampled.body.top_p, 0.9, 'top_p from the model config');
assert.strictEqual(sampled.body.top_k, 40, 'top_k from the model config');

const noSampling = await AnthropicAdapter.createCompletionRequest(
  {
    ...model,
    modelId: 'claude-opus-5',
    supportsTemperature: false,
    sampling: { temperature: 0.4, topP: 0.9 }
  },
  messages,
  'key'
);
for (const key of ['temperature', 'top_p', 'top_k']) {
  assert.ok(
    !(key in noSampling.body),
    `${key} must be absent, not null, when the model rejects sampling parameters`
  );
}
assert.strictEqual(noSampling.body.model, 'claude-opus-5');

logger.info('Anthropic adapter sampling-parameter test passed');
