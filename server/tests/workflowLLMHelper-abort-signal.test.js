/**
 * Regression test for #1683: WorkflowLLMHelper.executeStreamingRequest never
 * forwarded an AbortSignal to the underlying HTTP request, so
 * `engine.cancel()` / a per-node timeout could only stop an agent's tool loop
 * BETWEEN LLM calls — an in-flight fetch always ran to completion.
 *
 * `signal` must be threaded as a sibling parameter (not inside `options`),
 * because `filterAdapterOptions` only allowlists adapter-facing keys
 * (temperature, tools, ...) and would silently drop it if it were nested
 * there.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this
 * file uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';

let throttledFetchImpl;
const throttledFetchCalls = [];
jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: (...args) => {
    throttledFetchCalls.push(args);
    return throttledFetchImpl(...args);
  }
}));

const { WorkflowLLMHelper } = await import('../services/workflow/WorkflowLLMHelper.js');

// Real OpenAI-format "full response" chunk (not the streaming delta shape) —
// convertOpenAIResponseToGeneric treats `choices[0].message` as a complete,
// non-streaming reply and sets `result.complete = true` immediately, so a
// single SSE event is enough to end the read loop.
function sseResponse(content) {
  const encoder = new TextEncoder();
  const chunk = { choices: [{ message: { content }, finish_reason: 'stop' }] };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.close();
    }
  });
  return { ok: true, body };
}

const model = {
  id: 'test-model',
  modelId: 'test-model',
  provider: 'openai',
  maxOutputTokens: 4096
};

describe('WorkflowLLMHelper.executeStreamingRequest abort-signal threading (#1683)', () => {
  beforeEach(() => {
    throttledFetchCalls.length = 0;
  });

  test('a signal passed to executeStreamingRequest reaches the throttledFetch call', async () => {
    throttledFetchImpl = async () => sseResponse('hi');

    const helper = new WorkflowLLMHelper();
    const controller = new AbortController();

    await helper.executeStreamingRequest({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
      options: { temperature: 0.5 },
      signal: controller.signal
    });

    expect(throttledFetchCalls.length).toBe(1);
    const [, , fetchOptions] = throttledFetchCalls[0];
    expect(fetchOptions.signal).toBe(controller.signal);
  });

  test('omitting signal does not break the request (backward compatible)', async () => {
    throttledFetchImpl = async () => sseResponse('hi');

    const helper = new WorkflowLLMHelper();

    const result = await helper.executeStreamingRequest({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
      options: { temperature: 0.5 }
    });

    expect(result.content).toBe('hi');
    const [, , fetchOptions] = throttledFetchCalls[0];
    expect(fetchOptions.signal).toBeUndefined();
  });

  test('an already-aborted signal rejects the request as a non-retryable AbortError', async () => {
    let attempts = 0;
    throttledFetchImpl = async (_id, _url, opts) => {
      attempts += 1;
      if (opts.signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return sseResponse('hi');
    };

    const helper = new WorkflowLLMHelper();
    const controller = new AbortController();
    controller.abort();

    await expect(
      helper.executeStreamingRequest({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'sk-test',
        options: { temperature: 0.5 },
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Not retried: the retry loop must recognize AbortError as non-transient
    // (see isTransientLlmError in workflow-llm-retry.test.js) so a single
    // attempt is made, not maxRetries+1.
    expect(attempts).toBe(1);
  });
});
