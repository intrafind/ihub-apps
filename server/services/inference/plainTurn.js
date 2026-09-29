/**
 * A plain-model turn of the inference API: one model, no app, no tools run
 * on the server — straight through `LLMClient`, with the structured-output
 * contract on top.
 *
 * `LLMClient` owns key resolution, throttling, provider parsing and the
 * ledger; this module adds what structured output needs beyond the adapter
 * options: the Anthropic synthetic `json` tool call lifted back into the
 * answer text (so a caller sees `message.content` JSON exactly as OpenAI
 * returns it), a JSON instruction for providers without native enforcement,
 * server-side validation, and one corrected attempt when the answer does not
 * validate.
 *
 * @module services/inference/plainTurn
 */
import { addUsage } from '../loop/llmUsage.js';
import { structuredOutputRetryPrompt } from '../loop/seams/structuredOutputSeam.js';
import {
  adapterOptionsFor,
  createOutputValidator,
  jsonInstruction,
  structuredOutputSupport
} from './structuredOutput.js';

/** Name of the tool Anthropic's adapter forces for structured output. */
const JSON_TOOL = 'json';

function toolName(call) {
  return call?.function?.name || call?.name || '';
}

function toolArguments(call) {
  if (typeof call?.function?.arguments === 'string') return call.function.arguments;
  if (typeof call?.arguments === 'string') return call.arguments;
  if (call?.arguments && typeof call.arguments === 'object') return JSON.stringify(call.arguments);
  return '';
}

/**
 * Move the synthetic `json` tool call of a streamed chunk into its content.
 * The Anthropic converter emits the call whole, so its arguments are the
 * complete answer.
 *
 * @param {Object} chunk - Normalized GenericChunk.
 * @param {Object|null} format - Structured-output format of the turn.
 * @returns {Object} The chunk, or a copy with the call lifted.
 */
export function liftJsonToolChunk(chunk, format) {
  if (!format || !Array.isArray(chunk?.tool_calls) || chunk.tool_calls.length === 0) return chunk;
  const lifted = chunk.tool_calls.filter(call => toolName(call) === JSON_TOOL);
  if (lifted.length === 0) return chunk;
  return {
    ...chunk,
    content: [...(chunk.content || []), ...lifted.map(toolArguments)],
    tool_calls: chunk.tool_calls.filter(call => toolName(call) !== JSON_TOOL),
    ...(chunk.finishReason === 'tool_calls' ? { finishReason: 'stop' } : {})
  };
}

/**
 * The same lift on a collected CompletionResult.
 *
 * @param {Object} result
 * @param {Object|null} format
 * @returns {Object}
 */
export function liftJsonToolResult(result, format) {
  if (!format || !Array.isArray(result?.toolCalls)) return result;
  const lifted = result.toolCalls.filter(call => toolName(call) === JSON_TOOL);
  if (lifted.length === 0) return result;
  return {
    ...result,
    content: `${result.content || ''}${lifted.map(toolArguments).join('')}`,
    toolCalls: result.toolCalls.filter(call => toolName(call) !== JSON_TOOL),
    ...(result.finishReason === 'tool_calls' ? { finishReason: 'stop' } : {})
  };
}

/**
 * Add the JSON instruction to the system prompt of a model that does not
 * enforce a schema itself.
 *
 * @param {Array} messages
 * @param {Object} format
 * @returns {Array}
 */
export function withJsonInstruction(messages, format) {
  const instruction = jsonInstruction(format);
  const index = messages.findIndex(message => message.role === 'system');
  if (index === -1) return [{ role: 'system', content: instruction }, ...messages];
  return messages.map((message, i) =>
    i === index && typeof message.content === 'string'
      ? { ...message, content: `${message.content}\n\n${instruction}` }
      : message
  );
}

/**
 * Run a plain-model turn to completion.
 *
 * @param {Object} params
 * @param {import('../loop/LLMClient.js').LLMClient} params.llmClient
 * @param {Object} params.model
 * @param {Array} params.messages - Messages in the shape adapters take.
 * @param {Object} [params.options] - Adapter options (temperature, maxTokens, …).
 * @param {Object|null} [params.format] - Structured-output format.
 * @param {boolean} [params.validate=true] - Check the answer against the format.
 * @param {number} [params.maxRetries=1] - Corrected attempts after an invalid answer.
 * @param {AbortSignal} [params.signal]
 * @param {string} [params.language]
 * @param {Object} [params.telemetry] - Passed to `execute` (run id, purpose, …).
 * @param {(text: string) => void} [params.onText] - Streamed answer text.
 * @param {(info: {attempt: number, errors: Array}) => void} [params.onAttemptRejected]
 * @returns {Promise<Object>} The CompletionResult of the last attempt, with the
 *   usage of all attempts, `attempts` and — when validated — `structuredOutput`
 *   `{ valid, value?, errors?, attempts }` (a valid answer's `content` is the
 *   validated JSON).
 */
export async function runPlainTurn({
  llmClient,
  model,
  messages,
  options = {},
  format = null,
  validate = true,
  maxRetries = 1,
  signal,
  language,
  telemetry,
  onText = null,
  onAttemptRejected = null
}) {
  let attemptMessages =
    format && structuredOutputSupport(model) === 'prompted'
      ? withJsonInstruction(messages, format)
      : messages;
  const validator = format && validate ? createOutputValidator(format) : null;
  let usage = null;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const stream = await llmClient.execute({
      model,
      messages: attemptMessages,
      options: { ...options, ...adapterOptionsFor(format) },
      // Always streamed from the provider; see the chat completions route.
      stream: true,
      signal,
      language,
      retries: 0,
      telemetry
    });
    for await (const raw of stream) {
      const chunk = liftJsonToolChunk(raw, format);
      if (onText) {
        const text = (chunk.content || []).join('');
        if (text) onText(text);
      }
      if (chunk.complete) break;
    }
    const result = liftJsonToolResult(stream.result(), format);
    usage = result.usage ? addUsage(usage, result.usage) : usage;
    if (!validator || result.toolCalls.length > 0) return { ...result, usage, attempts };

    const verdict = validator(result.content);
    if (verdict.valid) {
      return {
        ...result,
        content: verdict.text,
        usage,
        attempts,
        structuredOutput: { valid: true, value: verdict.value, attempts }
      };
    }
    if (attempts > maxRetries) {
      return {
        ...result,
        usage,
        attempts,
        structuredOutput: { valid: false, errors: verdict.errors || [], attempts }
      };
    }
    if (typeof onAttemptRejected === 'function') {
      onAttemptRejected({ attempt: attempts, errors: verdict.errors || [] });
    }
    attemptMessages = [
      ...attemptMessages,
      // Providers refuse an empty assistant message.
      { role: 'assistant', content: result.content || '(no answer)' },
      { role: 'user', content: structuredOutputRetryPrompt(verdict.errors || []) }
    ];
  }
}
