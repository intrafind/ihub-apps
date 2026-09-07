/**
 * Test double for `LLMClient` built from a single `complete`-style function.
 *
 * The agent loop consumes the streaming primitive (`execute()` → async
 * iterable + `result()`), while most executor tests only want to script
 * "the model answers X". This wraps such a scripted `complete(params)` into
 * an object that satisfies both entry points:
 *
 *   const llmClient = fakeLlmClient(async ({ messages, options }) => ({
 *     content: 'done', toolCalls: [], usage: { promptTokens: 5, completionTokens: 5 }
 *   }));
 *   new PromptNodeExecutor({ llmClient });
 *
 * A thrown error propagates from `execute()` exactly like a provider failure.
 *
 * @param {Function|{complete: Function}} complete - scripted completion
 * @returns {{ complete: Function, execute: Function }}
 */
export function fakeLlmClient(complete) {
  const fn = typeof complete === 'function' ? complete : complete?.complete;
  if (typeof fn !== 'function') {
    throw new TypeError('fakeLlmClient expects a complete(params) function');
  }
  return {
    complete: async params => fn(params),
    async execute(params) {
      const result = (await fn(params)) || {};
      const snapshot = {
        requestId: result.requestId,
        runId: params?.telemetry?.runId ?? null,
        model: params?.model
          ? { id: params.model.id, provider: params.model.provider, modelId: params.model.modelId }
          : null,
        content: result.content || '',
        thinking: Array.isArray(result.thinking) ? result.thinking : [],
        toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
        thoughtSignatures: Array.isArray(result.thoughtSignatures) ? result.thoughtSignatures : [],
        images: Array.isArray(result.images) ? result.images : [],
        groundingMetadata: result.groundingMetadata || null,
        finishReason: result.finishReason ?? null,
        usage: result.usage || null,
        complete: true,
        chunkCount: 0,
        metadata: {}
      };
      const chunks = Array.isArray(result.chunks) ? result.chunks : [];
      return {
        meta: { model: params?.model, runId: snapshot.runId },
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
        result: () => snapshot
      };
    }
  };
}
