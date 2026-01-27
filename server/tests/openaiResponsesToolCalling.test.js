import assert from 'assert';
import { convertToolsFromGeneric } from '../adapters/toolCalling/index.js';
import logger from '../utils/logger.js';

// Test tool conversion for OpenAI Responses API
logger.info('Testing OpenAI Responses API tool conversion...\n');

// Test 1: Generic to Responses API format
logger.info('Test 1: Generic to Responses API format...');
const genericTools = [
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

const responsesTools = convertToolsFromGeneric(genericTools, 'openai-responses');

// Verify internally-tagged format (no nested function object)
assert.strictEqual(responsesTools.length, 1, 'Should have one tool');
assert.strictEqual(responsesTools[0].type, 'function', 'Type should be function');
assert.strictEqual(responsesTools[0].name, 'get_weather', 'Name should be at top level');
assert.strictEqual(
  responsesTools[0].description,
  'Get the current weather in a location',
  'Description should be at top level'
);
assert.ok(responsesTools[0].parameters, 'Parameters should be at top level');
assert.ok(!responsesTools[0].function, 'Should not have nested function object');

logger.info('Response API tool format:', JSON.stringify(responsesTools[0], null, 2));
logger.info('✓ Test 1 passed: Tools converted to internally-tagged format\n');

// Test 2: Compare with Chat Completions format
logger.info('Test 2: Verify difference from Chat Completions format...');
const chatCompletionsTools = convertToolsFromGeneric(genericTools, 'openai');

// Chat Completions uses externally-tagged format (nested function object)
assert.ok(chatCompletionsTools[0].function, 'Chat Completions should have nested function object');
assert.strictEqual(
  chatCompletionsTools[0].function.name,
  'get_weather',
  'Name should be in function object'
);

logger.info('Chat Completions tool format:', JSON.stringify(chatCompletionsTools[0], null, 2));
logger.info('✓ Test 2 passed: Chat Completions format is different (externally-tagged)\n');

logger.info('✅ All tool conversion tests passed!');
logger.info('\nKey difference: Responses API uses internally-tagged format (flat structure)');
logger.info('Chat Completions API uses externally-tagged format (nested function object)');
