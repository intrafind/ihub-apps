/**
 * Test to verify that google_search and function calling cannot be combined
 * This test validates the fix for the issue where Google's API rejects
 * requests that combine google_search with functionDeclarations
 */

import assert from 'assert';
import { convertGenericToolsToGoogle } from '../adapters/toolCalling/GoogleConverter.js';

console.log('Testing Google Search + Function Calling conflict resolution...');

// Test 1: Only google_search should work
const googleSearchOnly = [
  {
    id: 'googleSearch',
    name: 'googleSearch',
    description: 'Search the web using Google',
    parameters: { type: 'object', properties: {} }
  }
];

const result1 = convertGenericToolsToGoogle(googleSearchOnly);
assert.strictEqual(result1.length, 1, 'Should have 1 tool');
assert.deepStrictEqual(result1[0], { google_search: {} }, 'Should be google_search');
console.log('✓ Test 1: google_search only works correctly');

// Test 2: Only function tools should work
const functionToolsOnly = [
  {
    id: 'webContentExtractor',
    name: 'webContentExtractor',
    description: 'Extract content from a web page',
    parameters: { type: 'object', properties: { url: { type: 'string' } } }
  }
];

const result2 = convertGenericToolsToGoogle(functionToolsOnly);
assert.strictEqual(result2.length, 1, 'Should have 1 tool');
assert.ok(result2[0].functionDeclarations, 'Should have functionDeclarations');
assert.strictEqual(result2[0].functionDeclarations.length, 1, 'Should have 1 function declaration');
console.log('✓ Test 2: function tools only work correctly');

// Test 3: When both are present, google_search should take priority
const bothTools = [
  {
    id: 'googleSearch',
    name: 'googleSearch',
    description: 'Search the web using Google',
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'webContentExtractor',
    name: 'webContentExtractor',
    description: 'Extract content from a web page',
    parameters: { type: 'object', properties: { url: { type: 'string' } } }
  }
];

// Capture console.warn to verify warning is logged
let warnCalled = false;
let warnMessage = '';
const originalWarn = console.warn;
console.warn = (message) => {
  warnCalled = true;
  warnMessage = message;
};

const result3 = convertGenericToolsToGoogle(bothTools);

// Restore console.warn
console.warn = originalWarn;

assert.strictEqual(result3.length, 1, 'Should have only 1 tool when both are present');
assert.deepStrictEqual(
  result3[0],
  { google_search: {} },
  'Should prioritize google_search over function tools'
);
assert.ok(warnCalled, 'Should log a warning when skipping function tools');
assert.ok(
  warnMessage.includes('Google API limitation'),
  'Warning should mention Google API limitation'
);
assert.ok(
  warnMessage.includes('webContentExtractor'),
  'Warning should mention the skipped tool name'
);
console.log('✓ Test 3: google_search takes priority over function tools with warning');

// Test 4: Empty tools array
const emptyTools = [];
const result4 = convertGenericToolsToGoogle(emptyTools);
assert.strictEqual(result4.length, 0, 'Should return empty array for no tools');
console.log('✓ Test 4: empty tools array handled correctly');

console.log('\n✅ All tests passed! The fix prevents combining google_search with function calling.');
