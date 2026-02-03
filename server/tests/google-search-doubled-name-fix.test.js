/**
 * Test to verify that google_search_google_search function call name
 * is correctly normalized back to googleSearch
 *
 * This test validates the fix for the issue where Google's API returns
 * "google_search_google_search" as the function call name instead of
 * just "google_search", causing tool execution to fail.
 */

import assert from 'assert';
import { convertGoogleResponseToGeneric } from '../adapters/toolCalling/GoogleConverter.js';

console.log('Testing Google Search doubled name normalization fix...');

// Test 1: Verify google_search_google_search is normalized to googleSearch
const responseWithDoubledName = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: 'google_search_google_search',
              args: {
                queries: ['test query']
              }
            }
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP'
    }
  ]
});

const result1 = convertGoogleResponseToGeneric(responseWithDoubledName);
assert.strictEqual(result1.tool_calls.length, 1, 'Should have 1 tool call');
assert.strictEqual(
  result1.tool_calls[0].name,
  'googleSearch',
  'Function name should be normalized to googleSearch'
);
assert.deepStrictEqual(
  result1.tool_calls[0].arguments,
  { queries: ['test query'] },
  'Arguments should be preserved'
);
console.log('✓ Test 1: google_search_google_search normalized to googleSearch');

// Test 2: Verify google_search is also normalized to googleSearch
const responseWithSingleName = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: 'google_search',
              args: {
                queries: ['another query']
              }
            }
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP'
    }
  ]
});

const result2 = convertGoogleResponseToGeneric(responseWithSingleName);
assert.strictEqual(result2.tool_calls.length, 1, 'Should have 1 tool call');
assert.strictEqual(
  result2.tool_calls[0].name,
  'googleSearch',
  'Function name should be normalized to googleSearch'
);
console.log('✓ Test 2: google_search normalized to googleSearch');

// Test 3: Verify other function names are not affected
const responseWithNormalFunction = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: 'webContentExtractor',
              args: {
                url: 'https://example.com'
              }
            }
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP'
    }
  ]
});

const result3 = convertGoogleResponseToGeneric(responseWithNormalFunction);
assert.strictEqual(result3.tool_calls.length, 1, 'Should have 1 tool call');
assert.strictEqual(
  result3.tool_calls[0].name,
  'webContentExtractor',
  'Normal function names should not be changed'
);
console.log('✓ Test 3: Normal function names are not affected');

// Test 4: Streaming response with google_search_google_search
const streamingResponse = JSON.stringify({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: 'google_search_google_search',
              args: {
                queries: ['streaming query']
              }
            }
          }
        ]
      }
    }
  ]
});

const result4 = convertGoogleResponseToGeneric(streamingResponse);
assert.strictEqual(result4.tool_calls.length, 1, 'Should have 1 tool call in streaming');
assert.strictEqual(
  result4.tool_calls[0].name,
  'googleSearch',
  'Streaming function name should also be normalized'
);
console.log('✓ Test 4: Streaming response with google_search_google_search normalized correctly');

console.log(
  '\n✅ All tests passed! The fix correctly normalizes google_search_google_search to googleSearch.'
);
