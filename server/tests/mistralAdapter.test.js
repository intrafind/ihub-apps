import assert from 'assert';
import MistralAdapter from '../adapters/mistral.js';
import logger from '../utils/logger.js';

const model = {
  modelId: 'mistral-small',
  url: 'https://api.mistral.ai/v1/chat/completions',
  provider: 'mistral'
};
const messages = [{ role: 'user', content: 'test' }];

const schema = { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] };
const req = MistralAdapter.createCompletionRequest(model, messages, 'key', {
  responseFormat: 'json',
  responseSchema: schema
});

assert.deepStrictEqual(req.body.response_format, {
  type: 'json_schema',
  json_schema: { schema, name: 'response', strict: true }
});
logger.info('Mistral adapter structured output test passed');
