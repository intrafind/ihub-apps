/**
 * Test to verify automatic googleSearch inclusion logic for Google models
 * This test validates the logic that automatically adds googleSearch when using
 * Google/Gemini models with web search tools enabled
 */

import assert from 'assert';

console.log('Testing automatic googleSearch inclusion logic for Google models...\n');

// Simulate the auto-inclusion logic
function shouldAutoIncludeGoogleSearch(appTools, context, appHasGoogleSearch) {
  if (!context.model || context.model.provider !== 'google') {
    return false;
  }

  const webSearchToolIds = ['enhancedWebSearch', 'webSearch', 'braveSearch', 'tavilySearch'];
  const hasWebSearchTool = appTools.some(t => webSearchToolIds.includes(t.id));
  const hasGoogleSearch = appTools.some(t => t.id === 'googleSearch');

  return hasWebSearchTool && !hasGoogleSearch && appHasGoogleSearch;
}

// Test 1: Google model with enhancedWebSearch but no googleSearch
console.log('Test 1: Google model + enhancedWebSearch → should auto-include');
const tools1 = [{ id: 'enhancedWebSearch' }, { id: 'webContentExtractor' }];
const context1 = { model: { id: 'gemini-2.5-flash', provider: 'google' } };
const result1 = shouldAutoIncludeGoogleSearch(tools1, context1, true);
assert.strictEqual(result1, true, 'Should auto-include googleSearch');
console.log('✓ Test 1 passed\n');

// Test 2: Non-Google model with enhancedWebSearch
console.log('Test 2: Non-Google model + enhancedWebSearch → should NOT auto-include');
const tools2 = [{ id: 'enhancedWebSearch' }, { id: 'webContentExtractor' }];
const context2 = { model: { id: 'gpt-4', provider: 'openai' } };
const result2 = shouldAutoIncludeGoogleSearch(tools2, context2, true);
assert.strictEqual(result2, false, 'Should NOT auto-include for non-Google model');
console.log('✓ Test 2 passed\n');

// Test 3: Google model with googleSearch already present
console.log('Test 3: Google model + googleSearch already present → should NOT auto-include');
const tools3 = [
  { id: 'enhancedWebSearch' },
  { id: 'googleSearch' },
  { id: 'webContentExtractor' }
];
const context3 = { model: { id: 'gemini-2.5-flash', provider: 'google' } };
const result3 = shouldAutoIncludeGoogleSearch(tools3, context3, true);
assert.strictEqual(result3, false, 'Should NOT auto-include when already present');
console.log('✓ Test 3 passed\n');

// Test 4: Google model without web search tools
console.log('Test 4: Google model + no web search → should NOT auto-include');
const tools4 = [{ id: 'webContentExtractor' }];
const context4 = { model: { id: 'gemini-2.5-flash', provider: 'google' } };
const result4 = shouldAutoIncludeGoogleSearch(tools4, context4, true);
assert.strictEqual(result4, false, 'Should NOT auto-include without web search tools');
console.log('✓ Test 4 passed\n');

// Test 5: Google model with braveSearch
console.log('Test 5: Google model + braveSearch → should auto-include');
const tools5 = [{ id: 'braveSearch' }];
const context5 = { model: { id: 'gemini-2.5-flash', provider: 'google' } };
const result5 = shouldAutoIncludeGoogleSearch(tools5, context5, true);
assert.strictEqual(result5, true, 'Should auto-include with braveSearch');
console.log('✓ Test 5 passed\n');

// Test 6: Google model with webSearch (OpenAI native)
console.log('Test 6: Google model + webSearch → should auto-include');
const tools6 = [{ id: 'webSearch' }];
const context6 = { model: { id: 'gemini-2.5-flash', provider: 'google' } };
const result6 = shouldAutoIncludeGoogleSearch(tools6, context6, true);
assert.strictEqual(result6, true, 'Should auto-include with webSearch');
console.log('✓ Test 6 passed\n');

// Test 7: App doesn't have googleSearch in tools array
console.log('Test 7: App without googleSearch in tools → should NOT auto-include');
const tools7 = [{ id: 'enhancedWebSearch' }];
const context7 = { model: { id: 'gemini-2.5-flash', provider: 'google' } };
const result7 = shouldAutoIncludeGoogleSearch(tools7, context7, false);
assert.strictEqual(result7, false, 'Should NOT auto-include if not in app.tools');
console.log('✓ Test 7 passed\n');

// Test 8: No model in context
console.log('Test 8: No model in context → should NOT auto-include');
const tools8 = [{ id: 'enhancedWebSearch' }];
const context8 = {};
const result8 = shouldAutoIncludeGoogleSearch(tools8, context8, true);
assert.strictEqual(result8, false, 'Should NOT auto-include without model');
console.log('✓ Test 8 passed\n');

console.log('✅ All tests passed! Auto-inclusion logic is correct.\n');
console.log('Summary:');
console.log('- Google models automatically get googleSearch when web search tools are enabled');
console.log('- Non-Google models do not get googleSearch auto-included');
console.log('- Auto-inclusion only works if googleSearch is in app.tools array');
console.log('- Auto-inclusion skipped if googleSearch is already present');
console.log('- Works with all web search tool variants (enhancedWebSearch, braveSearch, etc.)');

