/**
 * Test to verify OpenAI converters filter out other web search tools when webSearch is present
 */

import assert from 'assert';
import { convertGenericToolsToOpenAI } from '../adapters/toolCalling/OpenAIConverter.js';
import { convertGenericToolsToOpenaiResponses } from '../adapters/toolCalling/OpenAIResponsesConverter.js';

console.log('Testing OpenAI web search tool filtering...\n');

// Test 1: OpenAI Converter - with webSearch, should filter out other search tools
console.log('Test 1: OpenAI Converter - webSearch present → filter out other search tools');
const tools1 = [
  {
    id: 'webSearch',
    name: 'webSearch',
    description: 'OpenAI native web search',
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

const result1 = convertGenericToolsToOpenAI(tools1);
const hasWebSearch1 = result1.some(t => t.function.name === 'webSearch');
const hasEnhanced1 = result1.some(t => t.function.name === 'enhancedWebSearch');
const hasBrave1 = result1.some(t => t.function.name === 'braveSearch');
const hasExtractor1 = result1.some(t => t.function.name === 'webContentExtractor');

assert.ok(hasWebSearch1, 'Should include webSearch');
assert.ok(!hasEnhanced1, 'Should NOT include enhancedWebSearch when webSearch is present');
assert.ok(!hasBrave1, 'Should NOT include braveSearch when webSearch is present');
assert.ok(hasExtractor1, 'Should include webContentExtractor (not a search tool)');
console.log('✓ Test 1 passed\n');

// Test 2: OpenAI Converter - without webSearch, should include other search tools
console.log('Test 2: OpenAI Converter - no webSearch → include other search tools');
const tools2 = [
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
const hasEnhanced2 = result2.some(t => t.function.name === 'enhancedWebSearch');
const hasBrave2 = result2.some(t => t.function.name === 'braveSearch');
const hasExtractor2 = result2.some(t => t.function.name === 'webContentExtractor');

assert.ok(hasEnhanced2, 'Should include enhancedWebSearch when webSearch is NOT present');
assert.ok(hasBrave2, 'Should include braveSearch when webSearch is NOT present');
assert.ok(hasExtractor2, 'Should include webContentExtractor');
console.log('✓ Test 2 passed\n');

// Test 3: OpenAI Converter - should filter out googleSearch regardless
console.log('Test 3: OpenAI Converter - should filter out googleSearch (different provider)');
const tools3 = [
  {
    id: 'googleSearch',
    name: 'googleSearch',
    description: 'Google search',
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
const hasGoogle3 = result3.some(t => t.function.name === 'googleSearch');
const hasEnhanced3 = result3.some(t => t.function.name === 'enhancedWebSearch');

assert.ok(!hasGoogle3, 'Should NOT include googleSearch (different provider)');
assert.ok(hasEnhanced3, 'Should include enhancedWebSearch');
console.log('✓ Test 3 passed\n');

// Test 4: OpenAI Responses Converter - with webSearch, should filter out other search tools
console.log('Test 4: OpenAI Responses Converter - webSearch present → filter out others');
const tools4 = [
  {
    id: 'webSearch',
    name: 'webSearch',
    description: 'OpenAI native web search',
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
    id: 'tavilySearch',
    name: 'tavilySearch',
    description: 'Tavily search',
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
const hasWebSearch4 = result4.some(t => t.type === 'web_search');
const hasEnhanced4 = result4.some(t => t.name === 'enhancedWebSearch');
const hasTavily4 = result4.some(t => t.name === 'tavilySearch');
const hasExtractor4 = result4.some(t => t.name === 'webContentExtractor');

assert.ok(hasWebSearch4, 'Should include webSearch');
assert.ok(!hasEnhanced4, 'Should NOT include enhancedWebSearch when webSearch is present');
assert.ok(!hasTavily4, 'Should NOT include tavilySearch when webSearch is present');
assert.ok(hasExtractor4, 'Should include webContentExtractor (not a search tool)');
console.log('✓ Test 4 passed\n');

// Test 5: OpenAI Responses Converter - without webSearch, should include other search tools
console.log('Test 5: OpenAI Responses Converter - no webSearch → include others');
const tools5 = [
  {
    id: 'enhancedWebSearch',
    name: 'enhancedWebSearch',
    description: 'Enhanced web search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    id: 'tavilySearch',
    name: 'tavilySearch',
    description: 'Tavily search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  }
];

const result5 = convertGenericToolsToOpenaiResponses(tools5);
const hasEnhanced5 = result5.some(t => t.name === 'enhancedWebSearch');
const hasTavily5 = result5.some(t => t.name === 'tavilySearch');

assert.ok(hasEnhanced5, 'Should include enhancedWebSearch when webSearch is NOT present');
assert.ok(hasTavily5, 'Should include tavilySearch when webSearch is NOT present');
console.log('✓ Test 5 passed\n');

console.log('✅ All tests passed! OpenAI converters correctly filter web search tools.\n');
console.log('Summary:');
console.log('- When webSearch (OpenAI native) is present, other search tools are filtered out');
console.log('- When webSearch is NOT present, generic search tools are included');
console.log('- Provider-specific tools (like googleSearch) are always filtered out');
console.log('- Non-search tools (like webContentExtractor) are not affected');
