/**
 * Test to verify OpenAI converters filter out provider-specific tools correctly
 *
 * This exercises the *generic* `provider` field filtering (an admin can mark
 * any custom tool as restricted to one provider) — it has nothing to do with
 * OpenAI's native web search anymore. That's resolved directly by
 * toolLoader.resolveNativeWebSearchProvider() and injected by
 * openai-responses.js via the `nativeWebSearch` request option (see
 * native-web-search.test.js), never through this generic tools pipeline.
 *
 * Key behaviors:
 * - A tool with `provider: 'openai-responses'` is included (as a regular
 *   function tool) only by the openai-responses converter.
 * - The regular OpenAI (chat completions) converter does NOT include it.
 * - A tool with `provider: 'google'` is filtered out from both OpenAI converters.
 */

import assert from 'assert';
import { convertGenericToolsToOpenAI } from '../adapters/toolCalling/OpenAIConverter.js';
import { convertGenericToolsToOpenaiResponses } from '../adapters/toolCalling/OpenAIResponsesConverter.js';

console.log('Testing OpenAI provider-specific tool filtering...\n');

// Test 1: OpenAI Converter - should filter out an openai-responses-restricted tool
console.log('Test 1: OpenAI Converter - openai-responses-restricted tool should be filtered');
const tools1 = [
  {
    id: 'exampleResponsesTool',
    name: 'exampleResponsesTool',
    description: 'A tool restricted to the openai-responses provider',
    provider: 'openai-responses',
    isSpecialTool: true,
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'enhancedWebSearch',
    name: 'enhancedWebSearch',
    description: 'Enhanced web search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'braveSearch',
    name: 'braveSearch',
    description: 'Brave search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'webContentExtractor',
    name: 'webContentExtractor',
    description: 'Extract web content',
    parameters: { type: 'object', properties: { url: { type: 'string' } } }
  }
];

const result1 = convertGenericToolsToOpenAI(tools1);
const hasResponsesTool1 = result1.some(t => t.function.name === 'exampleResponsesTool');
const hasEnhanced1 = result1.some(t => t.function.name === 'enhancedWebSearch');
const hasBrave1 = result1.some(t => t.function.name === 'braveSearch');
const hasExtractor1 = result1.some(t => t.function.name === 'webContentExtractor');

assert.ok(!hasResponsesTool1, 'Should NOT include the openai-responses-restricted tool');
assert.ok(hasEnhanced1, 'Should include enhancedWebSearch (universal tool)');
assert.ok(hasBrave1, 'Should include braveSearch (universal tool)');
assert.ok(hasExtractor1, 'Should include webContentExtractor (universal tool)');
console.log('✓ Test 1 passed\n');

// Test 2: OpenAI Converter - should include openai-specific tools
console.log('Test 2: OpenAI Converter - include openai-specific and universal tools');
const tools2 = [
  {
    id: 'myOpenaiTool',
    name: 'myOpenaiTool',
    description: 'An OpenAI specific tool',
    provider: 'openai',
    parameters: { type: 'object', properties: { input: { type: 'string' } } }
  },
  {
    id: 'enhancedWebSearch',
    name: 'enhancedWebSearch',
    description: 'Enhanced web search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'braveSearch',
    name: 'braveSearch',
    description: 'Brave search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'webContentExtractor',
    name: 'webContentExtractor',
    description: 'Extract web content',
    parameters: { type: 'object', properties: { url: { type: 'string' } } }
  }
];

const result2 = convertGenericToolsToOpenAI(tools2);
const hasOpenaiTool2 = result2.some(t => t.function.name === 'myOpenaiTool');
const hasEnhanced2 = result2.some(t => t.function.name === 'enhancedWebSearch');
const hasBrave2 = result2.some(t => t.function.name === 'braveSearch');
const hasExtractor2 = result2.some(t => t.function.name === 'webContentExtractor');

assert.ok(hasOpenaiTool2, 'Should include openai-specific tools');
assert.ok(hasEnhanced2, 'Should include enhancedWebSearch (universal tool)');
assert.ok(hasBrave2, 'Should include braveSearch (universal tool)');
assert.ok(hasExtractor2, 'Should include webContentExtractor (universal tool)');
console.log('✓ Test 2 passed\n');

// Test 3: OpenAI Converter - should filter out a google-restricted tool regardless
console.log('Test 3: OpenAI Converter - should filter out a google-restricted tool');
const tools3 = [
  {
    id: 'exampleGoogleTool',
    name: 'exampleGoogleTool',
    description: 'A tool restricted to the google provider',
    provider: 'google',
    isSpecialTool: true,
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'enhancedWebSearch',
    name: 'enhancedWebSearch',
    description: 'Enhanced web search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  }
];

const result3 = convertGenericToolsToOpenAI(tools3);
const hasGoogle3 = result3.some(t => t.function.name === 'exampleGoogleTool');
const hasEnhanced3 = result3.some(t => t.function.name === 'enhancedWebSearch');

assert.ok(!hasGoogle3, 'Should NOT include the google-restricted tool');
assert.ok(hasEnhanced3, 'Should include enhancedWebSearch');
console.log('✓ Test 3 passed\n');

// Test 4: OpenAI Responses Converter - includes its own provider-restricted tool
// as a regular function tool, alongside universal tools (no cross-filtering —
// native web search is not part of this pipeline anymore).
console.log(
  'Test 4: OpenAI Responses Converter - includes its own provider tool + universal tools'
);
const tools4 = [
  {
    id: 'exampleResponsesTool',
    name: 'exampleResponsesTool',
    description: 'A tool restricted to the openai-responses provider',
    provider: 'openai-responses',
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'enhancedWebSearch',
    name: 'enhancedWebSearch',
    description: 'Enhanced web search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'braveSearch',
    name: 'braveSearch',
    description: 'Brave search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'webContentExtractor',
    name: 'webContentExtractor',
    description: 'Extract web content',
    parameters: { type: 'object', properties: { url: { type: 'string' } } }
  }
];

const result4 = convertGenericToolsToOpenaiResponses(tools4);
const hasResponsesTool4 = result4.some(t => t.name === 'exampleResponsesTool');
const hasEnhanced4 = result4.some(t => t.name === 'enhancedWebSearch');
const hasBrave4 = result4.some(t => t.name === 'braveSearch');
const hasExtractor4 = result4.some(t => t.name === 'webContentExtractor');

assert.ok(hasResponsesTool4, 'Should include its own provider tool as a regular function tool');
assert.ok(hasEnhanced4, 'Should include enhancedWebSearch (universal tool)');
assert.ok(hasBrave4, 'Should include braveSearch (universal tool)');
assert.ok(hasExtractor4, 'Should include webContentExtractor (universal tool)');
console.log('✓ Test 4 passed\n');

// Test 5: OpenAI Responses Converter - universal tools included with no provider tool present
console.log('Test 5: OpenAI Responses Converter - universal tools included on their own');
const tools5 = [
  {
    id: 'enhancedWebSearch',
    name: 'enhancedWebSearch',
    description: 'Enhanced web search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'braveSearch',
    name: 'braveSearch',
    description: 'Brave search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  }
];

const result5 = convertGenericToolsToOpenaiResponses(tools5);
const hasEnhanced5 = result5.some(t => t.name === 'enhancedWebSearch');
const hasBrave5 = result5.some(t => t.name === 'braveSearch');

assert.ok(hasEnhanced5, 'Should include enhancedWebSearch');
assert.ok(hasBrave5, 'Should include braveSearch');
console.log('✓ Test 5 passed\n');

console.log('✅ All tests passed! OpenAI converters correctly filter provider-restricted tools.\n');
