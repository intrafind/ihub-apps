/**
 * Test to verify all converters properly filter out provider-specific tools
 *
 * Key behaviors:
 * - googleSearch (provider: 'google') should ONLY be included for Google converter
 * - webSearch (provider: 'openai-responses') should ONLY be included for OpenAI Responses converter
 * - Each converter should only include tools for its own provider or universal tools
 */

import assert from 'assert';
import { convertGenericToolsToOpenAI } from '../adapters/toolCalling/OpenAIConverter.js';
import { convertGenericToolsToOpenaiResponses } from '../adapters/toolCalling/OpenAIResponsesConverter.js';
import { convertGenericToolsToGoogle } from '../adapters/toolCalling/GoogleConverter.js';
import { convertGenericToolsToVLLM } from '../adapters/toolCalling/VLLMConverter.js';
import { convertGenericToolsToMistral } from '../adapters/toolCalling/MistralConverter.js';
import { convertGenericToolsToAnthropic } from '../adapters/toolCalling/AnthropicConverter.js';

console.log('Testing provider-specific tool filtering across all converters...\n');

// Common test tools including both special tools
const testTools = [
  {
    id: 'googleSearch',
    name: 'googleSearch',
    description: 'Google search grounding',
    provider: 'google',
    isSpecialTool: true,
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'webSearch',
    name: 'webSearch',
    description: 'OpenAI native web search',
    provider: 'openai-responses',
    isSpecialTool: true,
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'braveSearch',
    name: 'braveSearch',
    description: 'Brave search (universal tool)',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'webContentExtractor',
    name: 'webContentExtractor',
    description: 'Extract web content (universal tool)',
    parameters: { type: 'object', properties: { url: { type: 'string' } } }
  }
];

// Test 1: OpenAI Converter - should filter out both googleSearch and webSearch
console.log('Test 1: OpenAI Converter - filters out googleSearch and webSearch');
const openaiResult = convertGenericToolsToOpenAI(testTools);
const openaiToolNames = openaiResult.map(t => t.function.name);

assert.ok(!openaiToolNames.includes('googleSearch'), 'OpenAI should NOT include googleSearch');
assert.ok(!openaiToolNames.includes('webSearch'), 'OpenAI should NOT include webSearch');
assert.ok(openaiToolNames.includes('braveSearch'), 'OpenAI should include braveSearch (universal)');
assert.ok(openaiToolNames.includes('webContentExtractor'), 'OpenAI should include webContentExtractor (universal)');
console.log('✓ Test 1 passed - OpenAI filters: googleSearch, webSearch\n');

// Test 2: OpenAI Responses Converter - should include webSearch, filter googleSearch
console.log('Test 2: OpenAI Responses Converter - includes webSearch, filters googleSearch');
const responsesResult = convertGenericToolsToOpenaiResponses(testTools);
const hasWebSearchType = responsesResult.some(t => t.type === 'web_search');
const responsesToolNames = responsesResult.filter(t => t.name).map(t => t.name);

assert.ok(!responsesToolNames.includes('googleSearch'), 'OpenAI Responses should NOT include googleSearch');
assert.ok(hasWebSearchType, 'OpenAI Responses should include webSearch as web_search type');
// Note: braveSearch is filtered when webSearch is present
assert.ok(responsesToolNames.includes('webContentExtractor'), 'OpenAI Responses should include webContentExtractor');
console.log('✓ Test 2 passed - OpenAI Responses includes: webSearch; filters: googleSearch\n');

// Test 3: Google Converter - should include googleSearch, filter webSearch
console.log('Test 3: Google Converter - includes googleSearch, filters webSearch');
const googleResult = convertGenericToolsToGoogle(testTools);
// Google converter returns array of tool objects, googleSearch is converted to { google_search: {} }
const hasGoogleSearch = googleResult.some(t => t.google_search !== undefined);
const googleFunctionNames = googleResult
  .filter(t => t.functionDeclarations)
  .flatMap(t => t.functionDeclarations.map(f => f.name));

assert.ok(hasGoogleSearch, 'Google should include google_search');
assert.ok(!googleFunctionNames.includes('webSearch'), 'Google should NOT include webSearch');
// Note: When google_search is present, function declarations are not included (API limitation)
assert.ok(googleFunctionNames.length === 0, 'Google should skip function tools when google_search is present');
console.log('✓ Test 3 passed - Google includes: google_search; filters: webSearch, skips functions\n');

// Test 4: vLLM Converter - should filter both googleSearch and webSearch
console.log('Test 4: vLLM Converter - filters out googleSearch and webSearch');
const vllmResult = convertGenericToolsToVLLM(testTools);
const vllmToolNames = vllmResult.map(t => t.function.name);

assert.ok(!vllmToolNames.includes('googleSearch'), 'vLLM should NOT include googleSearch');
assert.ok(!vllmToolNames.includes('webSearch'), 'vLLM should NOT include webSearch');
assert.ok(vllmToolNames.includes('braveSearch'), 'vLLM should include braveSearch (universal)');
assert.ok(vllmToolNames.includes('webContentExtractor'), 'vLLM should include webContentExtractor (universal)');
console.log('✓ Test 4 passed - vLLM filters: googleSearch, webSearch\n');

// Test 5: Mistral Converter - should filter both googleSearch and webSearch
console.log('Test 5: Mistral Converter - filters out googleSearch and webSearch');
const mistralResult = convertGenericToolsToMistral(testTools);
const mistralToolNames = mistralResult.map(t => t.function.name);

assert.ok(!mistralToolNames.includes('googleSearch'), 'Mistral should NOT include googleSearch');
assert.ok(!mistralToolNames.includes('webSearch'), 'Mistral should NOT include webSearch');
assert.ok(mistralToolNames.includes('braveSearch'), 'Mistral should include braveSearch (universal)');
assert.ok(mistralToolNames.includes('webContentExtractor'), 'Mistral should include webContentExtractor (universal)');
console.log('✓ Test 5 passed - Mistral filters: googleSearch, webSearch\n');

// Test 6: Anthropic Converter - should filter both googleSearch and webSearch
console.log('Test 6: Anthropic Converter - filters out googleSearch and webSearch');
const anthropicResult = convertGenericToolsToAnthropic(testTools);
const anthropicToolNames = anthropicResult.map(t => t.name);

assert.ok(!anthropicToolNames.includes('googleSearch'), 'Anthropic should NOT include googleSearch');
assert.ok(!anthropicToolNames.includes('webSearch'), 'Anthropic should NOT include webSearch');
assert.ok(anthropicToolNames.includes('braveSearch'), 'Anthropic should include braveSearch (universal)');
assert.ok(anthropicToolNames.includes('webContentExtractor'), 'Anthropic should include webContentExtractor (universal)');
console.log('✓ Test 6 passed - Anthropic filters: googleSearch, webSearch\n');

console.log('✅ All tests passed! All converters properly filter provider-specific tools.\n');
console.log('Summary of provider-specific tool filtering:');
console.log('| Converter         | googleSearch | webSearch | Universal Tools |');
console.log('|-------------------|--------------|-----------|-----------------|');
console.log('| OpenAI            | ❌ filtered  | ❌ filtered | ✅ included    |');
console.log('| OpenAI Responses  | ❌ filtered  | ✅ included | ✅ included    |');
console.log('| Google            | ✅ included  | ❌ filtered | ✅ included*   |');
console.log('| vLLM              | ❌ filtered  | ❌ filtered | ✅ included    |');
console.log('| Mistral           | ❌ filtered  | ❌ filtered | ✅ included    |');
console.log('| Anthropic         | ❌ filtered  | ❌ filtered | ✅ included    |');
console.log('\n* Google has API limitation: google_search cannot be combined with function calling');
