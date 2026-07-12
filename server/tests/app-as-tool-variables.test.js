/**
 * Regression tests for #1725: variables passed to `ChatService.invokeAppInternal`
 * (used by the App-as-tool gateway) were silently discarded because
 * `prepareChatRequest`/`PromptService.processMessageTemplates` only read
 * variables off `lastUserMessage.variables`, never from a top-level request
 * param. Apps invoked as agent tools therefore left `{{variable}}`
 * placeholders unsubstituted in their system prompt.
 */

import ChatService from '../services/chat/ChatService.js';

function buildFakeRequestBuilder(capture) {
  return {
    prepareChatRequest: async params => {
      capture.params = params;
      return {
        success: true,
        data: {
          model: { id: 'test-model', provider: 'openai' },
          llmMessages: params.messages,
          request: {},
          tools: []
        }
      };
    }
  };
}

function fakeNonStreamingHandler() {
  return {
    executeNonStreamingResponse: async ({ res }) => {
      res.json({ choices: [{ message: { content: 'ok' } }] });
    }
  };
}

describe('ChatService.invokeAppInternal variable passthrough (#1725)', () => {
  test('attaches variables onto the last user message so PromptService substitution picks them up', async () => {
    const capture = {};
    const chatService = new ChatService({
      requestBuilder: buildFakeRequestBuilder(capture),
      nonStreamingHandler: fakeNonStreamingHandler()
    });

    const result = await chatService.invokeAppInternal({
      appId: 'test-app',
      user: { id: 'agent' },
      messages: [{ role: 'user', content: 'translate this' }],
      variables: { targetLanguage: 'French' },
      runId: 'test-run'
    });

    expect(result.status).toBe('ok');
    expect(capture.params).not.toBeNull();
    const lastUserMessage = capture.params.messages.findLast(m => m.role === 'user');
    expect(lastUserMessage.variables).toEqual({ targetLanguage: 'French' });
    // Nothing downstream reads a top-level `variables` param — it must not be forwarded.
    expect(capture.params.variables).toBeUndefined();
  });

  test('does not mutate the caller-provided message objects', async () => {
    const capture = {};
    const chatService = new ChatService({
      requestBuilder: buildFakeRequestBuilder(capture),
      nonStreamingHandler: fakeNonStreamingHandler()
    });

    const originalMessage = { role: 'user', content: 'translate this' };
    await chatService.invokeAppInternal({
      appId: 'test-app',
      user: { id: 'agent' },
      messages: [originalMessage],
      variables: { targetLanguage: 'French' },
      runId: 'test-run-mutate'
    });

    expect(originalMessage.variables).toBeUndefined();
  });

  test('is a no-op when no variables are provided', async () => {
    const capture = {};
    const chatService = new ChatService({
      requestBuilder: buildFakeRequestBuilder(capture),
      nonStreamingHandler: fakeNonStreamingHandler()
    });

    await chatService.invokeAppInternal({
      appId: 'test-app',
      user: { id: 'agent' },
      messages: [{ role: 'user', content: 'hi' }],
      runId: 'test-run-no-vars'
    });

    const lastUserMessage = capture.params.messages.findLast(m => m.role === 'user');
    expect(lastUserMessage.variables).toBeUndefined();
  });
});
