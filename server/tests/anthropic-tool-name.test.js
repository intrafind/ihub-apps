/**
 * Test for Anthropic tool name validation fix
 * Ensures that tool names are properly normalized to match Anthropic's requirements
 */

import assert from 'assert';
import { convertGenericToolsToAnthropic } from '../adapters/toolCalling/AnthropicConverter.js';
import logger from '../utils/logger.js';

logger.info('🧪 Testing Anthropic Tool Name Validation Fix\n');

// Test Case 1: Tool with localized name containing spaces and special characters
logger.info('Test 1: Tool with localized name (spaces and special characters)');
const localizedTool = {
  id: 'webContentExtractor',
  name: 'Web-Inhalts-Extraktor', // German localized name with hyphen
  description: 'Extract clean, readable content from a URL',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to extract content from'
      }
    },
    required: ['url']
  }
};

const anthropicToolsLocalized = convertGenericToolsToAnthropic([localizedTool]);
assert.strictEqual(
  anthropicToolsLocalized[0].name,
  'webContentExtractor',
  'Tool name should use ID instead of localized name'
);
logger.info('✓ Localized tool name correctly uses ID: webContentExtractor\n');

// Test Case 2: Tool with English name containing spaces
logger.info('Test 2: Tool with name containing spaces');
const toolWithSpaces = {
  id: 'enhancedWebSearch',
  name: 'Enhanced Web Search with Content',
  description: 'Performs web search and extracts content',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query'
      }
    },
    required: ['query']
  }
};

const anthropicToolsSpaces = convertGenericToolsToAnthropic([toolWithSpaces]);
assert.strictEqual(
  anthropicToolsSpaces[0].name,
  'enhancedWebSearch',
  'Tool name should use ID instead of name with spaces'
);
logger.info('✓ Tool name with spaces correctly uses ID: enhancedWebSearch\n');

// Test Case 3: Tool without ID (edge case - should fall back to name)
logger.info('Test 3: Tool without ID (fallback to name)');
const toolWithoutId = {
  name: 'simpleToolName',
  description: 'A simple tool',
  parameters: {
    type: 'object',
    properties: {}
  }
};

const anthropicToolsNoId = convertGenericToolsToAnthropic([toolWithoutId]);
assert.strictEqual(
  anthropicToolsNoId[0].name,
  'simpleToolName',
  'Tool name should fall back to name when ID is missing'
);
logger.info('✓ Tool without ID correctly falls back to name: simpleToolName\n');

// Test Case 4: Verify Anthropic pattern compliance
logger.info('Test 4: Verify Anthropic pattern compliance');
const anthropicNamePattern = /^[a-zA-Z0-9_-]{1,128}$/;

const testTools = [localizedTool, toolWithSpaces, toolWithoutId];
const convertedTools = convertGenericToolsToAnthropic(testTools);

convertedTools.forEach((tool, index) => {
  assert.ok(
    anthropicNamePattern.test(tool.name),
    `Tool ${index + 1} name "${tool.name}" should match Anthropic pattern ^[a-zA-Z0-9_-]{1,128}$`
  );
});
logger.info('✓ All tool names match Anthropic pattern: ^[a-zA-Z0-9_-]{1,128}$\n');

// Test Case 5: Multiple tools conversion
logger.info('Test 5: Multiple tools batch conversion');
const multipleTools = [
  {
    id: 'braveSearch',
    name: 'Brave Web / Internet Search',
    description: 'Search the web using Brave',
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'tavilySearch',
    name: 'Tavily Websuche',
    description: 'Search using Tavily',
    parameters: { type: 'object', properties: {} }
  },
  {
    id: 'deepResearch',
    name: 'Tiefgehende Recherche',
    description: 'Deep research',
    parameters: { type: 'object', properties: {} }
  }
];

const convertedMultiple = convertGenericToolsToAnthropic(multipleTools);
assert.strictEqual(convertedMultiple.length, 3, 'Should convert all tools');
assert.strictEqual(convertedMultiple[0].name, 'braveSearch', 'First tool should use ID');
assert.strictEqual(convertedMultiple[1].name, 'tavilySearch', 'Second tool should use ID');
assert.strictEqual(convertedMultiple[2].name, 'deepResearch', 'Third tool should use ID');
logger.info('✓ Multiple tools batch conversion successful\n');

logger.info('✅ All Anthropic tool name validation tests passed!');
