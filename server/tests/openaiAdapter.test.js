import assert from 'assert';
import OpenAIAdapter from '../adapters/openai.js';
import logger from '../utils/logger.js';

const model = {
  modelId: 'gpt-4',
  url: 'https://api.openai.com/v1/chat/completions',
  provider: 'openai'
};
const messages = [{ role: 'user', content: 'test' }];

const req = OpenAIAdapter.createCompletionRequest(model, messages, 'key', {
  responseFormat: 'json'
});

assert.deepStrictEqual(req.body.response_format, { type: 'json_object' });
logger.info('OpenAI adapter structured output test passed');
