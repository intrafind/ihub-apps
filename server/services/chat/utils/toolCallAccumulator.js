/**
 * Tool Call Accumulator
 *
 * Shared utility for merging streaming tool call chunks into complete tool calls.
 * Streaming responses send tool calls in incremental chunks (index, id, function name, arguments).
 * This function accumulates them into complete tool call objects.
 *
 * Consolidates previously duplicated logic from:
 * - ToolExecutor.processChatWithTools (with __raw_arguments handling)
 * - ToolExecutor.continueWithToolExecution (simpler version)
 * - WorkflowLLMHelper.mergeToolCalls
 *
 * @module services/chat/utils/toolCallAccumulator
 */

/**
 * Merge streaming tool call chunks into collected tool calls array.
 *
 * Handles:
 * - Index-based matching to accumulate chunks for the same tool call
 * - __raw_arguments passthrough for providers that send raw argument strings
 * - Smart empty {} filtering to avoid corrupted argument concatenation
 * - Metadata preservation (critical for Gemini thoughtSignatures)
 *
 * @param {Array} collectedCalls - Array of collected tool calls (mutated in place)
 * @param {Array} newCalls - New tool call chunks to merge
 */
export function mergeToolCalls(collectedCalls, newCalls) {
  for (const call of newCalls) {
    const existing = collectedCalls.find(c => c.index === call.index);

    if (existing) {
      if (call.id) existing.id = call.id;
      if (call.type) existing.type = call.type;

      // Preserve metadata (critical for Gemini thoughtSignatures)
      if (call.metadata) {
        existing.metadata = { ...(existing.metadata || {}), ...call.metadata };
      }

      if (call.function) {
        if (call.function.name) existing.function.name = call.function.name;

        // Handle arguments accumulation for streaming
        let callArgs = call.function.arguments;

        // Some providers send raw argument strings via __raw_arguments
        if (call.arguments && call.arguments.__raw_arguments) {
          callArgs = call.arguments.__raw_arguments;
        }

        if (callArgs) {
          // Smart concatenation: avoid empty {} + real args pattern
          const existingArgs = existing.function.arguments;
          if (!existingArgs || existingArgs === '{}' || existingArgs.trim() === '') {
            // If existing is empty or just {}, replace it entirely
            existing.function.arguments = callArgs;
          } else if (callArgs !== '{}' && callArgs.trim() !== '') {
            // Only concatenate if new args aren't empty
            existing.function.arguments += callArgs;
          }
        }
      }
    } else if (call.index !== undefined) {
      // Create a new tool call entry
      let initialArgs = call.function?.arguments || '';

      // Handle raw arguments passthrough
      if (call.arguments && call.arguments.__raw_arguments) {
        initialArgs = call.arguments.__raw_arguments;
      }

      // Clean up initial args - avoid starting with empty {}
      if (initialArgs === '{}' || initialArgs.trim() === '') {
        initialArgs = '';
      }

      collectedCalls.push({
        index: call.index,
        id: call.id || null,
        type: call.type || 'function',
        metadata: call.metadata || {},
        function: {
          name: call.function?.name || '',
          arguments: initialArgs
        }
      });
    }
  }
}
