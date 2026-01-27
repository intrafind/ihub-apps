import assert from 'assert';
import PromptService from '../services/PromptService.js';

logger.info('Testing PromptService prompt template handling...');

// Mock configCache for tests
const mockConfigCache = {
  getPlatform: () => ({ defaultLanguage: 'en' })
};

// Mock the configCache module
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
Object.assign(configCache, mockConfigCache);

// Test 1: Empty prompt template should still include user content
async function testEmptyPromptTemplate() {
  const messages = [
    {
      role: 'user',
      content: 'Hello, how are you?',
      promptTemplate: { en: '' },
      variables: {}
    }
  ];

  const app = {
    system: { en: 'You are a helpful assistant' }
  };

  const result = await PromptService.processMessageTemplates(
    messages,
    app,
    null,
    null,
    'en',
    null,
    null,
    null,
    null
  );

  // Should have system message and user message
  assert.strictEqual(result.length, 2, 'Should have 2 messages (system + user)');
  assert.strictEqual(result[0].role, 'system', 'First message should be system');
  assert.strictEqual(result[1].role, 'user', 'Second message should be user');
  assert.strictEqual(
    result[1].content,
    'Hello, how are you?',
    'User content should be preserved when template is empty'
  );

  logger.info('✓ Empty prompt template test passed');
}

// Test 2: Prompt template without {{content}} placeholder should append user content
async function testPromptTemplateWithoutContentPlaceholder() {
  const messages = [
    {
      role: 'user',
      content: 'Translate this: Hello world',
      promptTemplate: { en: 'Translate to French:' },
      variables: {}
    }
  ];

  const app = {
    system: { en: 'You are a translator' }
  };

  const result = await PromptService.processMessageTemplates(
    messages,
    app,
    null,
    null,
    'en',
    null,
    null,
    null,
    null
  );

  assert.strictEqual(result.length, 2, 'Should have 2 messages');
  assert.strictEqual(
    result[1].content,
    'Translate to French:\n\nTranslate this: Hello world',
    'User content should be appended when template lacks {{content}}'
  );

  logger.info('✓ Prompt template without {{content}} placeholder test passed');
}

// Test 3: Prompt template with {{content}} placeholder should replace correctly
async function testPromptTemplateWithContentPlaceholder() {
  const messages = [
    {
      role: 'user',
      content: 'Hello world',
      promptTemplate: { en: 'Translate this text: "{{content}}"' },
      variables: {}
    }
  ];

  const app = {
    system: { en: 'You are a translator' }
  };

  const result = await PromptService.processMessageTemplates(
    messages,
    app,
    null,
    null,
    'en',
    null,
    null,
    null,
    null
  );

  assert.strictEqual(result.length, 2, 'Should have 2 messages');
  assert.strictEqual(
    result[1].content,
    'Translate this text: "Hello world"',
    'User content should be correctly replaced in template'
  );

  logger.info('✓ Prompt template with {{content}} placeholder test passed');
}

// Test 4: Prompt template with variables and {{content}}
async function testPromptTemplateWithVariablesAndContent() {
  const messages = [
    {
      role: 'user',
      content: 'Hello',
      promptTemplate: { en: 'Translate to {{language}}: {{content}}' },
      variables: { language: 'French' }
    }
  ];

  const app = {
    system: { en: 'You are a translator' }
  };

  const result = await PromptService.processMessageTemplates(
    messages,
    app,
    null,
    null,
    'en',
    null,
    null,
    null,
    null
  );

  assert.strictEqual(result.length, 2, 'Should have 2 messages');
  assert.strictEqual(
    result[1].content,
    'Translate to French: Hello',
    'Variables and content should both be replaced'
  );

  logger.info('✓ Prompt template with variables and {{content}} test passed');
}

// Test 5: Empty content with variables should work
async function testEmptyContentWithVariables() {
  const messages = [
    {
      role: 'user',
      content: '',
      promptTemplate: { en: 'Language: {{language}}' },
      variables: { language: 'French' }
    }
  ];

  const app = {
    system: { en: 'You are a translator' }
  };

  const result = await PromptService.processMessageTemplates(
    messages,
    app,
    null,
    null,
    'en',
    null,
    null,
    null,
    null
  );

  assert.strictEqual(result.length, 2, 'Should have 2 messages');
  assert.strictEqual(
    result[1].content,
    'Language: French',
    'Variables should be replaced even with empty content'
  );

  logger.info('✓ Empty content with variables test passed');
}

// Test 6: String prompt template instead of object
async function testStringPromptTemplate() {
  const messages = [
    {
      role: 'user',
      content: 'Hello',
      promptTemplate: 'Message: {{content}}',
      variables: {}
    }
  ];

  const app = {
    system: { en: 'You are a helpful assistant' }
  };

  const result = await PromptService.processMessageTemplates(
    messages,
    app,
    null,
    null,
    'en',
    null,
    null,
    null,
    null
  );

  assert.strictEqual(result.length, 2, 'Should have 2 messages');
  assert.strictEqual(result[1].content, 'Message: Hello', 'String template should work correctly');

  logger.info('✓ String prompt template test passed');
}

// Run all tests
async function runTests() {
  try {
    await testEmptyPromptTemplate();
    await testPromptTemplateWithoutContentPlaceholder();
    await testPromptTemplateWithContentPlaceholder();
    await testPromptTemplateWithVariablesAndContent();
    await testEmptyContentWithVariables();
    await testStringPromptTemplate();

    logger.info('\n✅ All PromptService tests passed!');
  } catch (error) {
    logger.error('\n❌ Test failed:', error.message);
    logger.error(error.stack);
    process.exit(1);
  }
}

runTests();
