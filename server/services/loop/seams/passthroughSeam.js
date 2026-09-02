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

async function drainToolResponse(response, emit) {
  let full = '';
  if (response && typeof response[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response) {
      if (chunk) {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        full += text;
        await emit(text);
      }
    }
    return full;
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
          full += text;
          await emit(text);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return full;
  }
  if (typeof response === 'string') full = response;
  else if (response && typeof response === 'object') {
    full =
      typeof response.answer === 'string' ? response.answer : JSON.stringify(response, null, 2);
  } else full = String(response);
  if (full) await emit(full);
  return full;
}

export function passthroughSeam({ runTool, onChunk, onComplete, onError, buildParams } = {}) {
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
        const text = await drainToolResponse(response, chunk => onChunk?.(chunk, info, ctx));
        await onComplete?.(text, info, ctx);
        return {
          handled: true,
          execution: 'passthrough',
          message: { role: 'assistant', content: text, tool_source: toolId, tool_call_id: call.id },
          terminate: {
            status: 'completed',
            finishReason: 'tool_passthrough_complete',
            toolName: toolId
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
            error: err
          }
        };
      }
    }
  };
}
