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

// Test 7: Variable key with regex metacharacters should not throw and should substitute correctly
async function testVariableKeyWithRegexMetacharacters() {
  const messages = [
    {
      role: 'user',
      content: '',
      promptTemplate: { en: 'Value: {{foo(bar)}}' },
      variables: { 'foo(bar)': 'baz' }
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
  assert.strictEqual(
    result[1].content,
    'Value: baz',
    'Variable key with regex metacharacters should substitute without throwing'
  );

  logger.info('✓ Variable key with regex metacharacters test passed');
}

// Test 8: Content with $-patterns should be substituted literally, not interpreted
async function testContentWithDollarPatterns() {
  const messages = [
    {
      role: 'user',
      content: "Price is $& and $1 and $` and $'",
      promptTemplate: { en: 'Echo: {{content}}' },
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
  assert.strictEqual(
    result[1].content,
    "Echo: Price is $& and $1 and $` and $'",
    '$-patterns in content should be preserved literally, not treated as replacement patterns'
  );

  logger.info('✓ Content with $-patterns test passed');
}

// Test 9: System prompt variable substitution should not interpret $-patterns in the value
async function testSystemPromptWithDollarPatternVariable() {
  const messages = [{ role: 'user', content: 'Hi', variables: { location: '$100 & change' } }];

  const app = {
    system: { en: 'Location: {{location}}' }
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

  const systemMessage = result.find(msg => msg.role === 'system');
  assert.strictEqual(
    systemMessage.content,
    'Location: $100 & change',
    'System prompt should substitute $-pattern values literally'
  );

  logger.info('✓ System prompt with $-pattern variable test passed');
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
    await testVariableKeyWithRegexMetacharacters();
    await testContentWithDollarPatterns();
    await testSystemPromptWithDollarPatternVariable();

    logger.info('\n✅ All PromptService tests passed!');
  } catch (error) {
    logger.error('\n❌ Test failed:', error.message);
    logger.error(error.stack);
    process.exit(1);
  }
}

runTests();
