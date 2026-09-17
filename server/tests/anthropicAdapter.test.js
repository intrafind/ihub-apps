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

// --- Sampling parameters (issue #2282) -------------------------------------
// Anthropic removed `temperature` from Claude Opus 5 / Sonnet 5 / Fable 5.x:
// sending it returns a 400 and the whole request fails. Model configs opt out
// with `supportsTemperature: false` and the adapter must omit the field.
const withTemperature = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
  temperature: 0.4
});
assert.strictEqual(withTemperature.body.temperature, 0.4, 'temperature sent by default');

const noSampling = await AnthropicAdapter.createCompletionRequest(
  { ...model, modelId: 'claude-opus-5', supportsTemperature: false },
  messages,
  'key',
  { temperature: 0.4 }
);
assert.ok(
  !('temperature' in noSampling.body),
  'temperature must be absent, not null, when the model rejects sampling parameters'
);
assert.strictEqual(noSampling.body.model, 'claude-opus-5');

// A non-numeric temperature must not serialize as `null` (JSON.stringify turns
// NaN into null, which Anthropic rejects).
const badTemperature = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
  temperature: 'not-a-number'
});
assert.ok(!('temperature' in badTemperature.body), 'unparseable temperature is omitted');

logger.info('Anthropic adapter sampling-parameter test passed');
