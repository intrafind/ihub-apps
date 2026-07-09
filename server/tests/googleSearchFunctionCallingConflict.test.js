/**
 * Test to verify that native Google Search grounding and function calling
 * cannot be combined in the same request. This validates the fix for the
 * issue where Google's API rejects requests that combine google_search with
 * functionDeclarations.
 *
 * Native search is resolved and injected directly by google.js via the
 * `nativeWebSearch` request option (see native-web-search.test.js) — it no
 * longer flows through GoogleConverter's generic tool-calling pipeline.
 */

import assert from 'assert';
import GoogleAdapter from '../adapters/google.js';
import logger from '../utils/logger.js';

logger.info('Testing Google Search + Function Calling conflict resolution...');

const model = {
  modelId: 'gemini-2.5-flash',
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  provider: 'google'
};
const messages = [{ role: 'user', content: 'test' }];

// Test 1: Only native google_search should work
const req1 = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  nativeWebSearch: { provider: 'google' }
});
assert.strictEqual(req1.body.tools.length, 1, 'Should have 1 tool');
assert.deepStrictEqual(req1.body.tools[0], { google_search: {} }, 'Should be google_search');
logger.info('✓ Test 1: google_search only works correctly');

// Test 2: Only function tools should work
const functionToolsOnly = [
  {
    id: 'webContentExtractor',
    name: 'webContentExtractor',
    description: 'Extract content from a web page',
    parameters: { type: 'object', properties: { url: { type: 'string' } } }
  }
];

const req2 = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  tools: functionToolsOnly
});
assert.strictEqual(req2.body.tools.length, 1, 'Should have 1 tool');
assert.ok(req2.body.tools[0].functionDeclarations, 'Should have functionDeclarations');
assert.strictEqual(
  req2.body.tools[0].functionDeclarations.length,
  1,
  'Should have 1 function declaration'
);
logger.info('✓ Test 2: function tools only work correctly');

// Test 3: When both are requested, native google_search should take priority
// Capture logger.warn to verify warning is logged
let warnCalled = false;
let warnMessage = '';
let warnMeta = null;
const originalWarn = logger.warn;
logger.warn = (message, meta) => {
  warnCalled = true;
  warnMessage = message;
  warnMeta = meta;
};

const req3 = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
  nativeWebSearch: { provider: 'google' },
  tools: functionToolsOnly
});

// Restore logger.warn
logger.warn = originalWarn;

assert.strictEqual(req3.body.tools.length, 1, 'Should have only 1 tool when both are present');
assert.deepStrictEqual(
  req3.body.tools[0],
  { google_search: {} },
  'Should prioritize google_search over function tools'
);
assert.ok(warnCalled, 'Should log a warning when skipping function tools');
assert.ok(
  warnMessage.includes('Google API limitation'),
  'Warning should mention Google API limitation'
);
assert.ok(
  warnMeta?.skippedTools?.includes('webContentExtractor'),
  'Warning metadata should mention the skipped tool name'
);
logger.info('✓ Test 3: google_search takes priority over function tools with warning');

// Test 4: Empty tools array, no native search
const req4 = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {});
assert.strictEqual(req4.body.tools, undefined, 'Should have no tools field when nothing requested');
logger.info('✓ Test 4: no tools requested handled correctly');

logger.info(
  '\n✅ All tests passed! The fix prevents combining google_search with function calling.'
);
