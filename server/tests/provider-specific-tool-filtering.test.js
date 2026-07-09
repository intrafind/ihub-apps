/**
 * Test to verify all converters properly filter out provider-specific tools.
 *
 * This is the *generic* `isSpecialTool` / `provider` mechanism admins can use
 * to register an arbitrary provider-handled tool with no script (Admin →
 * Tools → "Special Tool"). It is unrelated to native web search: Google
 * Search grounding, OpenAI Web Search, and Anthropic Web Search are resolved
 * directly by toolLoader.resolveNativeWebSearchProvider() and injected by the
 * adapter (see native-web-search.test.js) — they never flow through this
 * generic tools pipeline.
 *
 * Key behavior: a tool with a `provider` field is only included for that
 * provider's converter (as a regular function tool); every other converter
 * excludes it, the same as any other cross-provider or unmatched special tool.
 */

import assert from 'assert';
import { convertGenericToolsToOpenAI } from '../adapters/toolCalling/OpenAIConverter.js';
import { convertGenericToolsToOpenaiResponses } from '../adapters/toolCalling/OpenAIResponsesConverter.js';
import { convertGenericToolsToGoogle } from '../adapters/toolCalling/GoogleConverter.js';
import { convertGenericToolsToVLLM } from '../adapters/toolCalling/VLLMConverter.js';
import { convertGenericToolsToMistral } from '../adapters/toolCalling/MistralConverter.js';
import { convertGenericToolsToAnthropic } from '../adapters/toolCalling/AnthropicConverter.js';

console.log('Testing provider-specific tool filtering across all converters...\n');

// Example provider-restricted "special" tools (admin-configured, no script) plus universal tools.
const testTools = [
  {
    id: 'exampleGoogleTool',
    name: 'exampleGoogleTool',
    description: 'Example provider-handled Google-only tool',
    provider: 'google',
    isSpecialTool: true,
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'exampleOpenAIResponsesTool',
    name: 'exampleOpenAIResponsesTool',
    description: 'Example provider-handled OpenAI-Responses-only tool',
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

// Test 1: OpenAI Converter - should filter out both provider-restricted tools
console.log('Test 1: OpenAI Converter - filters out provider-restricted tools');
const openaiResult = convertGenericToolsToOpenAI(testTools);
const openaiToolNames = openaiResult.map(t => t.function.name);

assert.ok(
  !openaiToolNames.includes('exampleGoogleTool'),
  'OpenAI should NOT include exampleGoogleTool'
);
assert.ok(
  !openaiToolNames.includes('exampleOpenAIResponsesTool'),
  'OpenAI should NOT include exampleOpenAIResponsesTool'
);
assert.ok(openaiToolNames.includes('braveSearch'), 'OpenAI should include braveSearch (universal)');
assert.ok(
  openaiToolNames.includes('webContentExtractor'),
  'OpenAI should include webContentExtractor (universal)'
);
console.log('✓ Test 1 passed - OpenAI filters both provider-restricted tools\n');

// Test 2: OpenAI Responses Converter - includes its own provider tool, filters Google's
console.log(
  'Test 2: OpenAI Responses Converter - includes its own provider tool, filters exampleGoogleTool'
);
const responsesResult = convertGenericToolsToOpenaiResponses(testTools);
const responsesToolNames = responsesResult.map(t => t.name);

assert.ok(
  !responsesToolNames.includes('exampleGoogleTool'),
  'OpenAI Responses should NOT include exampleGoogleTool'
);
assert.ok(
  responsesToolNames.includes('exampleOpenAIResponsesTool'),
  'OpenAI Responses should include its own provider tool as a regular function tool'
);
assert.ok(
  responsesToolNames.includes('webContentExtractor'),
  'OpenAI Responses should include webContentExtractor'
);
console.log('✓ Test 2 passed\n');

// Test 3: Google Converter - includes its own provider tool, filters OpenAI Responses'
console.log(
  'Test 3: Google Converter - includes its own provider tool, filters exampleOpenAIResponsesTool'
);
const googleResult = convertGenericToolsToGoogle(testTools);
const googleFunctionNames = googleResult
  .filter(t => t.functionDeclarations)
  .flatMap(t => t.functionDeclarations.map(f => f.name));

assert.ok(
  googleFunctionNames.includes('exampleGoogleTool'),
  'Google should include its own provider tool as a function declaration'
);
assert.ok(
  !googleFunctionNames.includes('exampleOpenAIResponsesTool'),
  'Google should NOT include exampleOpenAIResponsesTool'
);
assert.ok(
  googleFunctionNames.includes('braveSearch') &&
    googleFunctionNames.includes('webContentExtractor'),
  'Google should include universal tools alongside its own provider tool'
);
console.log('✓ Test 3 passed\n');

// Test 4: vLLM Converter - should filter out both provider-restricted tools
console.log('Test 4: vLLM Converter - filters out provider-restricted tools');
const vllmResult = convertGenericToolsToVLLM(testTools);
const vllmToolNames = vllmResult.map(t => t.function.name);

assert.ok(
  !vllmToolNames.includes('exampleGoogleTool'),
  'vLLM should NOT include exampleGoogleTool'
);
assert.ok(
  !vllmToolNames.includes('exampleOpenAIResponsesTool'),
  'vLLM should NOT include exampleOpenAIResponsesTool'
);
assert.ok(vllmToolNames.includes('braveSearch'), 'vLLM should include braveSearch (universal)');
assert.ok(
  vllmToolNames.includes('webContentExtractor'),
  'vLLM should include webContentExtractor (universal)'
);
console.log('✓ Test 4 passed\n');

// Test 5: Mistral Converter - should filter out both provider-restricted tools
console.log('Test 5: Mistral Converter - filters out provider-restricted tools');
const mistralResult = convertGenericToolsToMistral(testTools);
const mistralToolNames = mistralResult.map(t => t.function.name);

assert.ok(
  !mistralToolNames.includes('exampleGoogleTool'),
  'Mistral should NOT include exampleGoogleTool'
);
assert.ok(
  !mistralToolNames.includes('exampleOpenAIResponsesTool'),
  'Mistral should NOT include exampleOpenAIResponsesTool'
);
assert.ok(
  mistralToolNames.includes('braveSearch'),
  'Mistral should include braveSearch (universal)'
);
assert.ok(
  mistralToolNames.includes('webContentExtractor'),
  'Mistral should include webContentExtractor (universal)'
);
console.log('✓ Test 5 passed\n');

// Test 6: Anthropic Converter - should filter out both provider-restricted tools
console.log('Test 6: Anthropic Converter - filters out provider-restricted tools');
const anthropicResult = convertGenericToolsToAnthropic(testTools);
const anthropicToolNames = anthropicResult.map(t => t.name);

assert.ok(
  !anthropicToolNames.includes('exampleGoogleTool'),
  'Anthropic should NOT include exampleGoogleTool'
);
assert.ok(
  !anthropicToolNames.includes('exampleOpenAIResponsesTool'),
  'Anthropic should NOT include exampleOpenAIResponsesTool'
);
assert.ok(
  anthropicToolNames.includes('braveSearch'),
  'Anthropic should include braveSearch (universal)'
);
assert.ok(
  anthropicToolNames.includes('webContentExtractor'),
  'Anthropic should include webContentExtractor (universal)'
);
console.log('✓ Test 6 passed\n');

console.log('✅ All tests passed! All converters properly filter provider-specific tools.\n');
