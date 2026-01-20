/**
 * Test to verify GoogleConverter (generic tool calling) handles Gemini 3 function calling correctly
 */

import assert from 'assert';
import { convertGoogleResponseToGeneric } from '../adapters/toolCalling/GoogleConverter.js';

console.log('Testing GoogleConverter Gemini 3 function calling fix...\n');

// Test 1: Response with function call and STOP finish reason (Gemini 3 behavior)
console.log('Test 1: Gemini 3 response with function call and STOP finish reason');
const gemini3ResponseWithToolCall = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: 'enhancedWebSearch',
              args: { query: 'IntraFind iHub was ist das' }
            }
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP',
      index: 0
    }
  ]
});

const result1 = convertGoogleResponseToGeneric(gemini3ResponseWithToolCall);

console.log('Result:', JSON.stringify(result1, null, 2));
assert.strictEqual(result1.finishReason, 'tool_calls', 'Should preserve tool_calls finish reason');
assert.strictEqual(result1.tool_calls.length, 1, 'Should have one tool call');
assert.strictEqual(
  result1.tool_calls[0].name,
  'enhancedWebSearch',
  'Tool call name should be correct'
);
console.log('✓ Test 1 passed: Function calls are detected and finishReason is preserved\n');

// Test 2: Response without function call and STOP finish reason (normal behavior)
console.log('Test 2: Normal response without function call');
const normalResponse = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            text: 'This is a normal text response'
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP',
      index: 0
    }
  ]
});

const result2 = convertGoogleResponseToGeneric(normalResponse);

console.log('Result:', JSON.stringify(result2, null, 2));
assert.strictEqual(result2.finishReason, 'stop', 'Should have stop finish reason for normal text');
assert.strictEqual(result2.tool_calls.length, 0, 'Should have no tool calls');
assert.strictEqual(result2.content.length, 1, 'Should have text content');
console.log('✓ Test 2 passed: Normal responses work correctly\n');

// Test 3: Multiple function calls in one response
console.log('Test 3: Response with multiple function calls');
const multipleToolCallsResponse = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: 'webSearch',
              args: { query: 'first query' }
            }
          },
          {
            functionCall: {
              name: 'webContentExtractor',
              args: { url: 'https://example.com' }
            }
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP',
      index: 0
    }
  ]
});

const result3 = convertGoogleResponseToGeneric(multipleToolCallsResponse);

console.log('Result:', JSON.stringify(result3, null, 2));
assert.strictEqual(result3.finishReason, 'tool_calls', 'Should preserve tool_calls finish reason');
assert.strictEqual(result3.tool_calls.length, 2, 'Should have two tool calls');
console.log('✓ Test 3 passed: Multiple function calls are handled correctly\n');

console.log('All GoogleConverter tests passed! ✓');
console.log('\nSummary:');
console.log('- GoogleConverter correctly handles Gemini 3 responses with function calls');
console.log('- finishReason is properly preserved as "tool_calls" when function calls are present');
console.log('- Normal text responses still work as expected');
