import assert from 'assert';
import AnthropicAdapter from '../adapters/anthropic.js';

const model = { modelId: 'claude-4-sonnet', url: 'https://api.anthropic.com/v1/messages', provider: 'anthropic' };
const messages = [{ role: 'user', content: 'test' }];

const req = AnthropicAdapter.createCompletionRequest(model, messages, 'key', { responseFormat: 'json' });

assert.deepStrictEqual(req.body.response_format, { type: 'json_object' });
console.log('Anthropic adapter structured output test passed');
