import { describe, it } from 'node:test';
import assert from 'node:assert';
import PromptService from '../services/PromptService.js';

describe('Automatic Source Addition', () => {
  it('should automatically append sources when no {{sources}} placeholder exists', async () => {
    const messages = [
      {
        role: 'user',
        content: 'What is in the FAQ?'
      }
    ];

    const app = {
      id: 'test-app',
      system: { en: 'You are a helpful assistant.' },
      sources: ['faq'] // Reference to existing FAQ source
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

    assert.strictEqual(result.length, 2, 'Should have 2 messages (system + user)');
    assert.strictEqual(result[0].role, 'system', 'First message should be system');

    // Verify that source content was appended automatically
    const systemContent = result[0].content;
    assert.ok(
      systemContent.includes('You are a helpful assistant.'),
      'System prompt should contain original content'
    );
    // Check that content is longer than just the system prompt (indicates source was added)
    assert.ok(
      systemContent.length > 'You are a helpful assistant.'.length + 50,
      `System prompt should contain source content automatically appended. Length: ${systemContent.length}`
    );

    console.log('✓ Sources automatically appended when no placeholder exists');
  });

  it('should replace {{sources}} placeholder when it exists', async () => {
    const messages = [
      {
        role: 'user',
        content: 'What is in the FAQ?'
      }
    ];

    const app = {
      id: 'test-app-with-placeholder',
      system: { en: 'You are a helpful assistant. Use these sources: {{sources}}' },
      sources: ['faq']
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

    const systemContent = result[0].content;
    assert.ok(
      systemContent.includes('Use these sources:'),
      'System prompt should contain text before placeholder'
    );
    assert.ok(
      systemContent.length > 100,
      `System prompt should contain source content at placeholder location. Length: ${systemContent.length}`
    );
    assert.ok(
      !systemContent.includes('{{sources}}'),
      'Placeholder should be replaced'
    );

    console.log('✓ {{sources}} placeholder correctly replaced');
  });

  it('should not duplicate sources when placeholder exists', async () => {
    const messages = [
      {
        role: 'user',
        content: 'What is in the FAQ?'
      }
    ];

    const app = {
      id: 'test-app-no-duplicate',
      system: { en: 'You are a helpful assistant.\n\nSources:\n{{sources}}' },
      sources: ['faq']
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

    const systemContent = result[0].content;

    // The source content should appear once (in the placeholder position)
    // and not be duplicated at the end
    const placeholderIndex = 'You are a helpful assistant.\n\nSources:\n'.length;
    const contentAfterPlaceholder = systemContent.substring(placeholderIndex);

    // Verify placeholder was replaced
    assert.ok(
      !systemContent.includes('{{sources}}'),
      'Placeholder should be replaced'
    );

    // Verify content exists after placeholder location
    assert.ok(
      contentAfterPlaceholder.length > 50,
      'Source content should exist after placeholder'
    );

    console.log('✓ Sources not duplicated when placeholder exists');
  });

  it('should handle legacy {{source}} placeholder', async () => {
    const messages = [
      {
        role: 'user',
        content: 'What is in the FAQ?'
      }
    ];

    const app = {
      id: 'test-app-legacy',
      system: { en: 'You are a helpful assistant. Use this source: {{source}}' },
      sources: ['faq']
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

    const systemContent = result[0].content;
    assert.ok(
      systemContent.length > 100,
      `System prompt should contain source content. Length: ${systemContent.length}`
    );
    assert.ok(
      !systemContent.includes('{{source}}'),
      'Legacy placeholder should be replaced'
    );

    console.log('✓ Legacy {{source}} placeholder correctly handled');
  });

  it('should not append sources when no sources are configured', async () => {
    const messages = [
      {
        role: 'user',
        content: 'Hello'
      }
    ];

    const app = {
      id: 'test-app-no-sources',
      system: { en: 'You are a helpful assistant.' }
      // No sources configured
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

    const systemContent = result[0].content;
    assert.strictEqual(
      systemContent,
      'You are a helpful assistant.',
      'System prompt should be unchanged when no sources configured'
    );

    console.log('✓ No content appended when no sources configured');
  });
});
