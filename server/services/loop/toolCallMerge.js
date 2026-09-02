/**
 * Streaming tool-call delta accumulation.
 *
 * Providers stream a tool call as a series of partial objects sharing an
 * `index` (id + name first, then argument fragments, sometimes `{}` placeholders,
 * sometimes the whole call at once). This merges them into one finalized call
 * per index using the union of the rules previously duplicated in the chat
 * ToolExecutor and the workflow LLM helper:
 *
 *   - a call without `index` is ignored (not enough identity to merge)
 *   - `id` / `type` / `function.name` are filled in when they arrive
 *   - arguments come from `function.arguments` or `arguments.__raw_arguments`;
 *     an empty / `{}` placeholder never pollutes the accumulated string
 *   - `metadata` is shallow-merged (carries Gemini thought signatures)
 *
 * @module services/loop/toolCallMerge
 */

function rawArguments(call) {
  if (call?.arguments && typeof call.arguments === 'object' && call.arguments.__raw_arguments) {
    return String(call.arguments.__raw_arguments);
  }
  if (typeof call?.function?.arguments === 'string') return call.function.arguments;
  if (call?.function?.arguments && typeof call.function.arguments === 'object') {
    return JSON.stringify(call.function.arguments);
  }
  if (
    call?.arguments &&
    typeof call.arguments === 'object' &&
    !call.arguments.__raw_arguments &&
    Object.keys(call.arguments).length > 0 &&
    !call.function
  ) {
    return JSON.stringify(call.arguments);
  }
  return '';
}

function isPlaceholder(args) {
  return !args || args === '{}' || args.trim() === '';
}

/**
 * Merge one streamed tool-call delta into `collected` (mutated in place).
 *
 * @param {Array} collected - accumulated finalized calls
 * @param {Object} call - incoming generic tool call (partial or complete)
 * @returns {Array} the same `collected` array
 */
export function mergeToolCallDelta(collected, call) {
  if (!call || call.index === undefined || call.index === null) return collected;
  const existing = collected.find(c => c.index === call.index);
  const incomingArgs = rawArguments(call);

  if (existing) {
    if (call.id) existing.id = call.id;
    if (call.type) existing.type = call.type;
    if (call.function?.name) existing.function.name = call.function.name;
    else if (!existing.function.name && typeof call.name === 'string' && call.name) {
      existing.function.name = call.name;
    }
    if (call.metadata) existing.metadata = { ...(existing.metadata || {}), ...call.metadata };
    if (incomingArgs) {
      const current = existing.function.arguments;
      if (call.complete === true) {
        // A delta flagged complete carries the FULL argument string (OpenAI
        // Responses `function_call_arguments.done` / `output_item.done`) —
        // replace instead of appending to what the fragments accumulated.
        if (!isPlaceholder(incomingArgs) || isPlaceholder(current)) {
          existing.function.arguments = incomingArgs;
        }
      } else if (isPlaceholder(current)) {
        existing.function.arguments = isPlaceholder(incomingArgs) ? current || '' : incomingArgs;
      } else if (!isPlaceholder(incomingArgs)) {
        existing.function.arguments += incomingArgs;
      }
    }
    return collected;
  }

  collected.push({
    index: call.index,
    id: call.id || null,
    type: call.type || 'function',
    function: {
      name: call.function?.name || call.name || '',
      arguments: isPlaceholder(incomingArgs) ? '' : incomingArgs
    },
    metadata: call.metadata ? { ...call.metadata } : {}
  });
  return collected;
}

/**
 * Merge a batch of deltas.
 * @param {Array} collected
 * @param {Array} calls
 * @returns {Array}
 */
export function mergeToolCallDeltas(collected, calls) {
  if (!Array.isArray(calls)) return collected;
  for (const call of calls) mergeToolCallDelta(collected, call);
  return collected;
}

/**
 * Parse a finalized call's argument string into an object. Empty → `{}`;
 * invalid JSON → `{ __raw_arguments: string }` so the caller can surface the
 * problem to the model instead of crashing.
 *
 * @param {Object} call
 * @returns {Object}
 */
export function parseToolCallArguments(call) {
  const raw = call?.function?.arguments;
  if (!raw || (typeof raw === 'string' && raw.trim() === '')) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { __raw_arguments: raw };
  }
}
