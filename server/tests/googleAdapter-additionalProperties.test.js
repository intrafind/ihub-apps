import assert from 'assert';
import GoogleAdapter from '../adapters/google.js';
import logger from '../utils/logger.js';

const model = {
  modelId: 'gemini-3-pro',
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent',
  provider: 'google'
};

const messages = [{ role: 'user', content: 'test' }];

// Test 1: Schema with additionalProperties at root level
logger.info('Test 1: Schema with additionalProperties at root level');
const schemaWithAdditionalProps = {
  type: 'object',
  properties: {
    foo: { type: 'string' }
  },
  required: ['foo'],
  additionalProperties: false
};

const req1 = GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  responseFormat: 'json',
  responseSchema: schemaWithAdditionalProps
});

// Verify additionalProperties is removed
assert.strictEqual(req1.body.generationConfig.response_schema.additionalProperties, undefined);
assert.strictEqual(req1.body.generationConfig.response_schema.type, 'object');
assert.deepStrictEqual(req1.body.generationConfig.response_schema.properties, {
  foo: { type: 'string' }
});
logger.info('✓ Test 1 passed: additionalProperties removed from root level');

// Test 2: Schema with nested additionalProperties
logger.info('\nTest 2: Schema with nested additionalProperties');
const schemaWithNestedAdditionalProps = {
  type: 'object',
  properties: {
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['severity', 'description'],
        additionalProperties: false
      }
    }
  },
  required: ['risks'],
  additionalProperties: false
};

const req2 = GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  responseFormat: 'json',
  responseSchema: schemaWithNestedAdditionalProps
});

// Verify additionalProperties is removed at all levels
assert.strictEqual(req2.body.generationConfig.response_schema.additionalProperties, undefined);
assert.strictEqual(
  req2.body.generationConfig.response_schema.properties.risks.items.additionalProperties,
  undefined
);
logger.info('✓ Test 2 passed: additionalProperties removed from nested objects');

// Test 3: Verify original schema is not mutated
logger.info('\nTest 3: Verify original schema is not mutated');
const originalSchema = {
  type: 'object',
  properties: {
    test: { type: 'string' }
  },
  additionalProperties: false
};

const req3 = GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  responseFormat: 'json',
  responseSchema: originalSchema
});

// Original schema should still have additionalProperties
assert.strictEqual(originalSchema.additionalProperties, false);
// But the request should not
assert.strictEqual(req3.body.generationConfig.response_schema.additionalProperties, undefined);
logger.info('✓ Test 3 passed: original schema not mutated');

// Test 4: Schema without additionalProperties should work fine
logger.info('\nTest 4: Schema without additionalProperties');
const schemaWithoutAdditionalProps = {
  type: 'object',
  properties: {
    bar: { type: 'number' }
  },
  required: ['bar']
};

const req4 = GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  responseFormat: 'json',
  responseSchema: schemaWithoutAdditionalProps
});

assert.strictEqual(req4.body.generationConfig.response_schema.additionalProperties, undefined);
assert.strictEqual(req4.body.generationConfig.responseMimeType, 'application/json');
logger.info('✓ Test 4 passed: schema without additionalProperties works');

logger.info('\n✅ All tests passed! additionalProperties is correctly removed from Google schemas');
