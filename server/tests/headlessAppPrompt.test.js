import { jest } from '@jest/globals';

/**
 * Headless app invocations (MCP gateway, A2A, app-as-tool) build their own
 * messages instead of going through the browser client, which is the only
 * caller that used to attach the app's `prompt` as `promptTemplate`. Without
 * it, `PromptService.processMessageTemplates` skipped templating entirely and
 * every declared app variable was dropped — a translator invoked over MCP with
 * `language: "German"` answered in whatever language it felt like.
 *
 * These tests pin the message shape `ChatService.invokeAppInternal` hands to
 * the prompt pipeline, then run that shape through the real PromptService to
 * prove the variable actually reaches the model.
 */

jest.unstable_mockModule('../configCache.js', () => ({
  resolveEnvVarsInObject: obj => obj,
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getFeatures: () => ({}),
    getApps: () => ({ data: [] }),
    getTools: () => ({ data: [] }),
    getModels: () => ({ data: [] }),
    getSources: () => ({ data: [] })
  }
}));

const { withAppPrompt } = await import('../services/chat/ChatService.js');
const { default: PromptService } = await import('../services/PromptService.js');

const TRANSLATOR_PROMPT = {
  en: 'Selected Language: "{{language}}" - Text to translate: "{{content}}"'
};

describe('withAppPrompt', () => {
  it('attaches variables and the app prompt template to the last user message', () => {
    const out = withAppPrompt(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'Hello world' }
      ],
      { language: 'German' },
      TRANSLATOR_PROMPT
    );

    expect(out[2]).toMatchObject({
      content: 'Hello world',
      variables: { language: 'German' },
      promptTemplate: TRANSLATOR_PROMPT
    });
    // Earlier turns are left alone.
    expect(out[0].promptTemplate).toBeUndefined();
    expect(out[1].promptTemplate).toBeUndefined();
  });

  it('applies the template even when the app declares no variables', () => {
    const [msg] = withAppPrompt([{ role: 'user', content: 'hi' }], {}, TRANSLATOR_PROMPT);
    expect(msg.promptTemplate).toEqual(TRANSLATOR_PROMPT);
    expect(msg.variables).toEqual({});
  });

  it('is a no-op when the app has neither prompt nor variables', () => {
    const input = [{ role: 'user', content: 'hi' }];
    expect(withAppPrompt(input, {}, null)).toBe(input);
  });

  it('does not override a template the caller already set', () => {
    const [msg] = withAppPrompt(
      [{ role: 'user', content: 'hi', promptTemplate: { en: 'caller wins' } }],
      { language: 'German' },
      TRANSLATOR_PROMPT
    );
    expect(msg.promptTemplate).toEqual({ en: 'caller wins' });
  });

  it('leaves messages untouched when there is no user turn', () => {
    const input = [{ role: 'assistant', content: 'hi' }];
    expect(withAppPrompt(input, { language: 'German' }, TRANSLATOR_PROMPT)).toBe(input);
  });
});

describe('headless invocation reaches the model with its variables', () => {
  it('interpolates app variables into the rendered user message', async () => {
    const app = {
      id: 'translator',
      system: { en: 'You are a helpful translation assistant.' },
      prompt: TRANSLATOR_PROMPT,
      variables: [{ name: 'language', type: 'string', required: true }]
    };

    // Exactly what invokeAppInternal now builds for an MCP tools/call of
    // translator({ message: 'The quick brown fox.', language: 'German' }).
    const messages = withAppPrompt(
      [{ role: 'user', content: 'The quick brown fox.' }],
      { language: 'German' },
      app.prompt
    );

    const rendered = await PromptService.processMessageTemplates(
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

    const userMessage = rendered.find(m => m.role === 'user');
    expect(userMessage.content).toBe(
      'Selected Language: "German" - Text to translate: "The quick brown fox."'
    );
  });

  it('drops the variable when the template is missing (the pre-fix shape)', async () => {
    const app = {
      id: 'translator',
      system: { en: 'You are a helpful translation assistant.' },
      prompt: TRANSLATOR_PROMPT
    };

    const rendered = await PromptService.processMessageTemplates(
      // What headless callers used to send: variables, but no promptTemplate.
      [{ role: 'user', content: 'The quick brown fox.', variables: { language: 'German' } }],
      app,
      null,
      null,
      'en',
      null,
      null,
      null,
      null
    );

    const userMessage = rendered.find(m => m.role === 'user');
    expect(userMessage.content).toBe('The quick brown fox.');
    expect(userMessage.content).not.toContain('German');
  });
});
