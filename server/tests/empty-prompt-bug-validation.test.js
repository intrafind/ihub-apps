import assert from 'assert';
import PromptService from '../services/PromptService.js';

console.log('Testing empty prompt template scenario (the bug case)...');

// Mock configCache for test
const mockConfigCache = {
  getPlatform: () => ({ defaultLanguage: 'en' })
};

import configCache from '../configCache.js';
Object.assign(configCache, mockConfigCache);

async function testEmptyPromptTemplateBugScenario() {
  // This simulates the bug scenario:
  // 1. User creates an app with empty prompt template
  // 2. User enters "What is the capital of France?"
  // 3. Before fix: The message sent to LLM would be empty
  // 4. After fix: The user's content is preserved

  const messages = [
    {
      role: 'user',
      content: 'What is the capital of France?',
      promptTemplate: { en: '' }, // Empty template - the bug scenario!
      variables: {}
    }
  ];

  const app = {
    system: { en: 'You are a helpful geography assistant' }
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

  console.log('\nTest Input:');
  console.log('  User content:', messages[0].content);
  console.log('  Prompt template:', messages[0].promptTemplate.en || '(empty)');

  console.log('\nResult:');
  console.log('  System message:', result[0].content.substring(0, 50) + '...');
  console.log('  User message:', result[1].content);

  // Verify the fix works
  assert.strictEqual(result.length, 2, 'Should have 2 messages (system + user)');
  assert.strictEqual(result[1].role, 'user', 'Second message should be user');
  assert.strictEqual(
    result[1].content,
    'What is the capital of France?',
    'User content must be preserved even with empty template'
  );
  assert.notStrictEqual(result[1].content, '', 'User message must not be empty');

  console.log('\n✅ Bug fix validated: Empty prompt template no longer loses user content!');
}

testEmptyPromptTemplateBugScenario().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
