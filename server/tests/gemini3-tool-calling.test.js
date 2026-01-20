/**
 * Test to verify Gemini 3 function calling fix
 * This test ensures that when Gemini 3 returns finishReason: "STOP" but includes function calls,
 * the adapter correctly preserves finishReason: "tool_calls" instead of overwriting it.
 */

import assert from 'assert';
import GoogleAdapter from '../adapters/google.js';

console.log('Testing Gemini 3 function calling fix...\n');

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
      finishReason: 'STOP', // Gemini 3 returns STOP even with function calls
      index: 0
    }
  ]
});

const result1 = GoogleAdapter.processResponseBuffer(gemini3ResponseWithToolCall);

console.log('Result:', JSON.stringify(result1, null, 2));
assert.strictEqual(result1.finishReason, 'tool_calls', 'Should preserve tool_calls finish reason');
assert.strictEqual(result1.tool_calls.length, 1, 'Should have one tool call');
assert.strictEqual(
  result1.tool_calls[0].function.name,
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

const result2 = GoogleAdapter.processResponseBuffer(normalResponse);

console.log('Result:', JSON.stringify(result2, null, 2));
assert.strictEqual(result2.finishReason, 'stop', 'Should have stop finish reason for normal text');
assert.strictEqual(result2.tool_calls.length, 0, 'Should have no tool calls');
assert.strictEqual(result2.content.length, 1, 'Should have text content');
console.log('✓ Test 2 passed: Normal responses work correctly\n');

// Test 3: Streaming chunks with function call (Gemini 3 streaming behavior)
console.log('Test 3: Streaming response with function call');
const streamingChunkWithToolCall = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: 'webSearch',
              args: { query: 'test query' }
            }
          }
        ]
      }
    }
  ]
});

const streamingChunkWithFinish = JSON.stringify({
  candidates: [
    {
      finishReason: 'STOP'
    }
  ]
});

// First chunk with function call
const result3a = GoogleAdapter.processResponseBuffer(streamingChunkWithToolCall);
console.log('Streaming chunk 1:', JSON.stringify(result3a, null, 2));
assert.strictEqual(result3a.tool_calls.length, 1, 'Should have tool call from first chunk');
assert.strictEqual(
  result3a.finishReason,
  'tool_calls',
  'Should have tool_calls finish reason from first chunk'
);

// Second chunk with STOP finish reason
const result3b = GoogleAdapter.processResponseBuffer(streamingChunkWithFinish);
console.log('Streaming chunk 2:', JSON.stringify(result3b, null, 2));

console.log('✓ Test 3 passed: Streaming responses work correctly\n');

// Test 4: Multiple function calls in one response
console.log('Test 4: Response with multiple function calls');
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

const result4 = GoogleAdapter.processResponseBuffer(multipleToolCallsResponse);

console.log('Result:', JSON.stringify(result4, null, 2));
assert.strictEqual(result4.finishReason, 'tool_calls', 'Should preserve tool_calls finish reason');
assert.strictEqual(result4.tool_calls.length, 2, 'Should have two tool calls');
console.log('✓ Test 4 passed: Multiple function calls are handled correctly\n');

console.log('All tests passed! ✓');
console.log('\nSummary:');
console.log('- Gemini 3 responses with function calls now correctly preserve finishReason: "tool_calls"');
console.log('- Normal text responses still work as expected');
console.log('- Streaming responses handle function calls correctly');
console.log('- Multiple function calls in a single response are supported');
