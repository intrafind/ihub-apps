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

const req = GoogleAdapter.createCompletionRequest(model, messages, 'key', {
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

const toolReq = GoogleAdapter.createCompletionRequest(model, messages, 'key', {
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
