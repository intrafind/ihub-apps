/**
 * Test strict mode for OpenAI Responses API tool calling
 * Verifies that tools are formatted with strict: true and additionalProperties: false
 */

import { convertGenericToolsToOpenaiResponses } from '../adapters/toolCalling/OpenAIResponsesConverter.js';
import assert from 'assert';

console.log('Testing OpenAI Responses API strict mode for tool calling...\n');

// Test 1: Simple tool with object parameters
console.log('Test 1: Tool with object parameters gets strict mode...');
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
      required: ['location']
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
console.log('✓ Test 1 passed: strict: true and additionalProperties: false added\n');

// Test 2: Nested object parameters
console.log('Test 2: Nested objects also get additionalProperties: false...');
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

const result2 = convertGenericToolsToOpenaiResponses(nestedTool);
console.log('Converted nested tool:', JSON.stringify(result2[0], null, 2));

assert.strictEqual(result2[0].strict, true, 'Tool should have strict: true');
assert.strictEqual(
  result2[0].parameters.additionalProperties,
  false,
  'Top-level object should have additionalProperties: false'
);
assert.strictEqual(
  result2[0].parameters.properties.config.additionalProperties,
  false,
  'Nested object should have additionalProperties: false'
);
assert.strictEqual(
  result2[0].parameters.properties.items.items.additionalProperties,
  false,
  'Array item object should have additionalProperties: false'
);
console.log('✓ Test 2 passed: All nested objects have additionalProperties: false\n');

// Test 3: Verify format matches OpenAI documentation example
console.log('Test 3: Format matches OpenAI documentation example...');
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

const result3 = convertGenericToolsToOpenaiResponses(docExample);
console.log('Documentation example format:', JSON.stringify(result3[0], null, 2));

// Expected format from docs:
const expectedStructure = {
  type: 'function',
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
    required: ['location'],
    additionalProperties: false
  },
  strict: true
};

assert.strictEqual(result3[0].type, expectedStructure.type);
assert.strictEqual(result3[0].name, expectedStructure.name);
assert.strictEqual(result3[0].description, expectedStructure.description);
assert.strictEqual(result3[0].strict, expectedStructure.strict);
assert.strictEqual(
  result3[0].parameters.additionalProperties,
  expectedStructure.parameters.additionalProperties
);
console.log('✓ Test 3 passed: Format matches OpenAI documentation\n');

console.log('✅ All strict mode tests passed!');
console.log('\nKey changes:');
console.log('1. Added strict: true to all tool definitions');
console.log('2. Added additionalProperties: false to all object schemas (including nested)');
console.log('3. Format now matches OpenAI Responses API documentation requirements');
