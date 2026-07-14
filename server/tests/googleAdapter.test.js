import assert from 'assert';
import GoogleAdapter from '../adapters/google.js';
import logger from '../utils/logger.js';

const model = {
  modelId: 'gemini-pro',
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
  provider: 'google'
};
const messages = [{ role: 'user', content: 'test' }];
const schema = { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] };

const req = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  responseFormat: 'json',
  responseSchema: schema
});

assert.strictEqual(req.body.generationConfig.responseMimeType, 'application/json');
assert.deepStrictEqual(req.body.generationConfig.responseSchema, schema);
logger.info('Google adapter structured output test passed');

// Regression: MCP tool schemas include JSON Schema meta keywords ($schema,
// additionalProperties) that Google's restricted OpenAPI subset rejects with
// HTTP 400 ("Unknown name ..."). The adapter must strip them before sending.
const mcpTool = {
  id: 'echo',
  name: 'echo',
  description: 'Echoes back the input',
  parameters: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      message: { type: 'string', description: 'text to echo' },
      // A property literally named additionalProperties must be preserved.
      additionalProperties: { type: 'string', description: 'edge case property name' }
    },
    required: ['message']
  }
};

const toolReq = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  tools: [mcpTool]
});

const declaredParams = toolReq.body.tools[0].functionDeclarations[0].parameters;
const serialized = JSON.stringify(toolReq.body.tools);

assert.ok(!serialized.includes('$schema'), '$schema must be stripped from tool parameters');
assert.strictEqual(
  declaredParams.additionalProperties,
  undefined,
  'additionalProperties keyword must be stripped'
);
assert.ok(
  declaredParams.properties.additionalProperties,
  'a property literally named additionalProperties must be preserved'
);
assert.ok(declaredParams.properties.message, 'message property must be preserved');
assert.deepStrictEqual(declaredParams.required, ['message'], 'required must be preserved');
logger.info('Google adapter MCP tool schema sanitization test passed');

// Regression: the API key must never appear in the request URL (it gets
// logged verbatim on provider HTTP errors) — it must be sent via the
// x-goog-api-key header instead, matching the header-based auth pattern
// used by every other adapter.
const streamingReq = await GoogleAdapter.createCompletionRequest(model, messages, 'secret-key', {
  stream: true
});
assert.ok(!streamingReq.url.includes('secret-key'), 'streaming URL must not contain the API key');
assert.ok(!streamingReq.url.includes('key='), 'streaming URL must not contain a key= parameter');
assert.strictEqual(streamingReq.headers['x-goog-api-key'], 'secret-key');
assert.ok(streamingReq.url.includes('alt=sse'), 'streaming URL must still request SSE');

const nonStreamingReq = await GoogleAdapter.createCompletionRequest(model, messages, 'secret-key', {
  stream: false
});
assert.ok(
  !nonStreamingReq.url.includes('secret-key'),
  'non-streaming URL must not contain the API key'
);
assert.ok(
  !nonStreamingReq.url.includes('key='),
  'non-streaming URL must not contain a key= parameter'
);
assert.strictEqual(nonStreamingReq.headers['x-goog-api-key'], 'secret-key');
logger.info('Google adapter API key header test passed');
