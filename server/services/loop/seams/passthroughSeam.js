/**
 * Passthrough tools (chat behaviour): a tool marked `passthrough: true`
 * (workflow tools invoked from chat) streams its own answer straight to the
 * user and ends the turn — the model gets no follow-up call. The result is
 * appended to the transcript as an assistant message tagged with `tool_source`.
 *
 * The seam is constructed with the tool runner and an optional chunk sink:
 *
 *   passthroughSeam({ runTool, onChunk(text, info, ctx), onComplete(text, info, ctx) })
 *
 * @module services/loop/seams/passthroughSeam
 */

/**
 * Ceiling for the text a passthrough tool may leave in the transcript
 * (10 MB, the limit the old in-memory sink enforced). Streaming to the client
 * continues past it; the collected copy is truncated with a marker so a huge
 * or hostile tool response cannot exhaust the heap.
 */
export const MAX_PASSTHROUGH_TEXT_CHARS = 10 * 1024 * 1024;
const TRUNCATION_MARKER = '\n\n[… output truncated: passthrough response exceeded the 10 MB limit]';

/** Accumulates streamed text up to the ceiling; keeps streaming afterwards. */
function boundedCollector(limit = MAX_PASSTHROUGH_TEXT_CHARS) {
  let full = '';
  let truncated = false;
  return {
    add(text) {
      if (truncated) return;
      if (full.length + text.length <= limit) {
        full += text;
        return;
      }
      full += text.slice(0, Math.max(0, limit - full.length)) + TRUNCATION_MARKER;
      truncated = true;
    },
    get text() {
      return full;
    },
    get truncated() {
      return truncated;
    }
  };
}

async function drainToolResponse(response, emit, { limit } = {}) {
  const collected = boundedCollector(limit);
  if (response && typeof response[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response) {
      if (chunk) {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        collected.add(text);
        await emit(text);
      }
    }
    return collected.text;
  }
  if (response && response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) {
          collected.add(text);
          await emit(text);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return collected.text;
  }
  let full;
  if (typeof response === 'string') full = response;
  else if (response && typeof response === 'object') {
    full =
      typeof response.answer === 'string' ? response.answer : JSON.stringify(response, null, 2);
  } else full = String(response);
  if (full) {
    collected.add(full);
    await emit(full);
  }
  return collected.text;
}

export { drainToolResponse };

export function passthroughSeam({
  runTool,
  onChunk,
  onComplete,
  onError,
  buildParams,
  maxTextChars
} = {}) {
  return {
    name: 'passthrough',
    async preTool(ctx, info) {
      const { toolDef, toolId, args, call } = info;
      if (!toolDef || toolDef.passthrough !== true) return null;
      const params = buildParams
        ? buildParams(info, ctx)
        : { ...args, chatId: ctx.refs.chatId, passthrough: true };
      try {
        const response = await runTool(toolId, params, { ctx, info });
        const text = await drainToolResponse(response, chunk => onChunk?.(chunk, info, ctx), {
          limit: maxTextChars
        });
        await onComplete?.(text, info, ctx);
        return {
          handled: true,
          execution: 'passthrough',
          message: { role: 'assistant', content: text, tool_source: toolId, tool_call_id: call.id },
          terminate: {
            status: 'completed',
            finishReason: 'tool_passthrough_complete',
            toolName: toolId,
            content: text
          }
        };
      } catch (err) {
        await onError?.(err, info, ctx);
        const message = `I encountered an error while processing your request: ${err.message}`;
        return {
          handled: true,
          execution: 'passthrough',
          message: {
            role: 'assistant',
            content: message,
            tool_source: toolId,
            tool_call_id: call.id,
            error: true
          },
          terminate: {
            status: 'completed',
            finishReason: 'tool_passthrough_complete',
            toolName: toolId,
            content: message,
            error: err
          }
        };
      }
    }
  };
}
