/**
 * Test to verify that google_search_google_search function call name
 * is correctly mapped to googleSearch tool ID while preserving the original
 * name for response echoing back to Google
 */

import assert from 'assert';
import { convertGoogleResponseToGeneric } from '../adapters/toolCalling/GoogleConverter.js';

console.log('Testing Google Search doubled name mapping and preservation fix...');

// Test 1: google_search_google_search mapped to googleSearch with original preserved
const response1 = JSON.stringify({
  candidates: [{
    content: {
      parts: [{
        functionCall: {
          name: 'google_search_google_search',
          args: { queries: ['test query'] }
        }
      }]
    },
    finishReason: 'STOP'
  }]
});

const result1 = convertGoogleResponseToGeneric(response1);
assert.strictEqual(result1.tool_calls[0].name, 'googleSearch');
assert.strictEqual(result1.tool_calls[0].metadata.originalGoogleName, 'google_search_google_search');
console.log('✓ Test 1: google_search_google_search mapped with original preserved');

// Test 2: google_search also mapped to googleSearch
const response2 = JSON.stringify({
  candidates: [{
    content: {
      parts: [{
        functionCall: {
          name: 'google_search',
          args: { queries: ['another query'] }
        }
      }]
    },
    finishReason: 'STOP'
  }]
});

const result2 = convertGoogleResponseToGeneric(response2);
assert.strictEqual(result2.tool_calls[0].name, 'googleSearch');
assert.strictEqual(result2.tool_calls[0].metadata.originalGoogleName, 'google_search');
console.log('✓ Test 2: google_search mapped with original preserved');

// Test 3: Normal function names unchanged
const response3 = JSON.stringify({
  candidates: [{
    content: {
      parts: [{
        functionCall: {
          name: 'webContentExtractor',
          args: { url: 'https://example.com' }
        }
      }]
    },
    finishReason: 'STOP'
  }]
});

const result3 = convertGoogleResponseToGeneric(response3);
assert.strictEqual(result3.tool_calls[0].name, 'webContentExtractor');
assert.strictEqual(result3.tool_calls[0].metadata.originalGoogleName, 'webContentExtractor');
console.log('✓ Test 3: Normal function names pass through unchanged');

console.log('\n✅ All tests passed! Fix correctly maps google_search variations while preserving originals.');
