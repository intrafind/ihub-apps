import assert from 'assert';
import GoogleAdapter from '../adapters/google.js';

const model = {
  modelId: 'gemini-pro',
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
  provider: 'google'
};
const messages = [{ role: 'user', content: 'test' }];
const schema = { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] };

const req = GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  responseFormat: 'json',
  responseSchema: schema
});

assert.strictEqual(req.body.generationConfig.responseMimeType, 'application/json');
assert.deepStrictEqual(req.body.generationConfig.response_schema, schema);
console.log('Google adapter structured output test passed');
