import assert from 'assert';
import GoogleAdapter from '../adapters/google.js';
import logger from '../utils/logger.js';

// This test simulates the exact scenario from the issue:
// NDA risk analyzer app with structured output schema
// that includes additionalProperties: false

const model = {
  modelId: 'gemini-3-pro',
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent',
  provider: 'google'
};

const messages = [{ role: 'user', content: 'Test file upload' }];

// Schema similar to nda-risk-analyzer app
// The issue mentions "additionalProperties" appearing in both:
// - 'generation_config.response_schema.properties[1].value.items'
// - 'generation_config.response_schema'
const ndaLikeSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Brief summary of the analysis'
    },
    risks: {
      type: 'array',
      description: 'List of identified risks',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['high', 'medium', 'low']
          },
          category: {
            type: 'string'
          },
          description: {
            type: 'string'
          }
        },
        required: ['severity', 'category', 'description'],
        additionalProperties: false // This was causing the error
      }
    }
  },
  required: ['summary', 'risks'],
  additionalProperties: false // This was also causing the error
};

logger.info('Testing NDA Risk Analyzer scenario from the issue...');
logger.info('\nOriginal schema has additionalProperties at:');
logger.info('- Root level:', ndaLikeSchema.additionalProperties);
logger.info('- Array items:', ndaLikeSchema.properties.risks.items.additionalProperties);

const req = GoogleAdapter.createCompletionRequest(model, messages, 'test-key', {
  responseFormat: 'json',
  responseSchema: ndaLikeSchema,
  stream: true
});

logger.info('\nAfter processing:');
logger.info(
  '- Root level additionalProperties:',
  req.body.generationConfig.response_schema.additionalProperties
);
logger.info(
  '- Array items additionalProperties:',
  req.body.generationConfig.response_schema.properties.risks.items.additionalProperties
);

// Verify the fix
assert.strictEqual(
  req.body.generationConfig.response_schema.additionalProperties,
  undefined,
  'Root level additionalProperties should be removed'
);
assert.strictEqual(
  req.body.generationConfig.response_schema.properties.risks.items.additionalProperties,
  undefined,
  'Nested additionalProperties in array items should be removed'
);

// Verify the schema structure is preserved
assert.strictEqual(req.body.generationConfig.response_schema.type, 'object');
assert.strictEqual(req.body.generationConfig.response_schema.properties.risks.type, 'array');
assert.strictEqual(req.body.generationConfig.response_schema.properties.risks.items.type, 'object');

// Verify original schema was not mutated
assert.strictEqual(ndaLikeSchema.additionalProperties, false);
assert.strictEqual(ndaLikeSchema.properties.risks.items.additionalProperties, false);

logger.info('\n✅ NDA Risk Analyzer scenario test passed!');
logger.info('The fix correctly removes additionalProperties that was causing:');
logger.info(
  '  - "Unknown name \\"additionalProperties\\" at \'generation_config.response_schema.properties[1].value.items\'"'
);
logger.info(
  '  - "Unknown name \\"additionalProperties\\" at \'generation_config.response_schema\'"'
);
