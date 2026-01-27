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
const req = AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
  responseSchema: schema
});

const jsonTool = req.body.tools.find(t => t.name === 'json');
assert.ok(jsonTool, 'json tool added');
assert.deepStrictEqual(jsonTool.input_schema, schema);
assert.deepStrictEqual(req.body.tool_choice, { type: 'tool', name: 'json' });
assert.strictEqual(req.body.response_format, undefined);
logger.info('Anthropic adapter structured output test passed');
