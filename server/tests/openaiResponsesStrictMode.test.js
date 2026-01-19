/**
 * Test strict mode for OpenAI Responses API tool calling
 * Verifies that tools are formatted with strict: true and additionalProperties: false
 * and that all properties are included in the required array
 */

import { convertGenericToolsToOpenaiResponses } from '../adapters/toolCalling/OpenAIResponsesConverter.js';
import assert from 'assert';

console.log('Testing OpenAI Responses API strict mode for tool calling...\n');

// Test 1: Simple tool with object parameters - all properties become required
console.log('Test 1: Tool with optional parameters - all properties in required array...');
const simpleTool = [
  {
    id: 'get_weather',
    name: 'get_weather',
    description: 'Get the current weather in a location',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The city and state, e.g. San Francisco, CA'
        },
        unit: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description: 'The temperature unit'
        }
      },
      required: ['location'] // Only location is required in the original schema
    }
  }
];

const result1 = convertGenericToolsToOpenaiResponses(simpleTool);
console.log('Converted tool:', JSON.stringify(result1[0], null, 2));

assert.strictEqual(result1[0].strict, true, 'Tool should have strict: true');
assert.strictEqual(
  result1[0].parameters.additionalProperties,
  false,
  'Top-level object should have additionalProperties: false'
);
// In strict mode, ALL properties must be in required array
assert.deepStrictEqual(
  result1[0].parameters.required.sort(),
  ['location', 'unit'].sort(),
  'All properties must be in required array for strict mode'
);
console.log('✓ Test 1 passed: All properties added to required array\n');

// Test 2: Tool with optional property (maxLength) that has default
console.log('Test 2: Tool matching webContentExtractor error case...');
const webContentExtractorLike = [
  {
    id: 'webContentExtractor',
    name: 'webContentExtractor',
    description: 'Extract clean content from a URL',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to extract content from'
        },
        maxLength: {
          type: 'integer',
          description: 'Maximum content length',
          default: 5000,
          minimum: 100,
          maximum: 50000
        },
        ignoreSSL: {
          type: 'boolean',
          description: 'Ignore invalid SSL certificates',
          default: false
        }
      },
      required: ['url'] // Only url is required
    }
  }
];

const result2 = convertGenericToolsToOpenaiResponses(webContentExtractorLike);
console.log('Converted webContentExtractor-like tool:', JSON.stringify(result2[0], null, 2));

assert.strictEqual(result2[0].strict, true, 'Tool should have strict: true');
assert.strictEqual(
  result2[0].parameters.additionalProperties,
  false,
  'Top-level object should have additionalProperties: false'
);
// Must include all properties: url, maxLength, and ignoreSSL
assert.deepStrictEqual(
  result2[0].parameters.required.sort(),
  ['url', 'maxLength', 'ignoreSSL'].sort(),
  'All properties including optional ones must be in required array'
);
console.log('✓ Test 2 passed: webContentExtractor case - all properties in required\n');

// Test 3: Nested object parameters
console.log('Test 3: Nested objects also get all properties in required...');
const nestedTool = [
  {
    id: 'complex_tool',
    name: 'complex_tool',
    description: 'A tool with nested objects',
    parameters: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            setting1: { type: 'string' },
            setting2: { type: 'number' }
          },
          required: ['setting1']
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'number' }
            }
          }
        }
      },
      required: ['config']
    }
  }
];

const result3 = convertGenericToolsToOpenaiResponses(nestedTool);
console.log('Converted nested tool:', JSON.stringify(result3[0], null, 2));

assert.strictEqual(result3[0].strict, true, 'Tool should have strict: true');
assert.strictEqual(
  result3[0].parameters.additionalProperties,
  false,
  'Top-level object should have additionalProperties: false'
);
assert.deepStrictEqual(
  result3[0].parameters.required.sort(),
  ['config', 'items'].sort(),
  'Top-level required should include all properties'
);
assert.deepStrictEqual(
  result3[0].parameters.properties.config.required.sort(),
  ['setting1', 'setting2'].sort(),
  'Nested object required should include all properties'
);
assert.deepStrictEqual(
  result3[0].parameters.properties.items.items.required.sort(),
  ['name', 'value'].sort(),
  'Array item object required should include all properties'
);
console.log('✓ Test 3 passed: All nested objects have all properties in required\n');

// Test 4: Verify format matches OpenAI documentation example
console.log('Test 4: Format matches OpenAI strict mode requirements...');
const docExample = [
  {
    id: 'get_weather',
    name: 'get_weather',
    description: 'Get current temperature for a given location.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City and country e.g. Bogotá, Colombia'
        }
      },
      required: ['location']
    }
  }
];

const result4 = convertGenericToolsToOpenaiResponses(docExample);
console.log('Documentation example format:', JSON.stringify(result4[0], null, 2));

assert.strictEqual(result4[0].type, 'function');
assert.strictEqual(result4[0].name, 'get_weather');
assert.strictEqual(result4[0].strict, true);
assert.strictEqual(result4[0].parameters.additionalProperties, false);
assert.deepStrictEqual(result4[0].parameters.required, ['location']);
console.log('✓ Test 4 passed: Format matches OpenAI strict mode requirements\n');

console.log('✅ All strict mode tests passed!');
console.log('\nKey changes:');
console.log('1. Added strict: true to all tool definitions');
console.log('2. Added additionalProperties: false to all object schemas (including nested)');
console.log('3. ALL properties are added to required array (strict mode requirement)');
console.log('4. Format now matches OpenAI Responses API strict mode requirements');
