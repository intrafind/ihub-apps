/**
 * Gemini thought signature helpers.
 *
 * Thinking Gemini models (the 2.5 and 3 series) return a `thoughtSignature`
 * field on the content parts of a response — an encrypted snapshot of the
 * model's reasoning state. For function calling, Gemini 3 *strictly validates*
 * that those signatures come back in the conversation history:
 *
 *   - The signature sits on the FIRST `functionCall` part of a model response.
 *     With parallel function calls the remaining parts carry no signature.
 *   - Validation covers every function call in the *current turn* — the turn
 *     starts at the most recent user message with standard content (text), not
 *     at a `functionResponse`. Earlier turns are not validated.
 *   - Omitting a required signature fails the request with
 *     `400 ... Function call <name> in the <n> content block is missing a
 *     thought_signature`.
 *
 * On an OpenAI-compatible surface there is no field for this, so Google's
 * compatibility layer nests it inside each tool call as
 * `extra_content.google.thought_signature`. We both emit that shape (so callers
 * of our own `/api/inference` endpoint can round-trip it) and accept it on the
 * way back in.
 *
 * When a caller cannot give us a signature at all — a strict OpenAI SDK that
 * drops unknown fields, or history replayed from another model — Google
 * documents two sentinel values that skip validation instead of erroring. We
 * use one as a last resort so the request degrades to "no preserved reasoning
 * context" rather than a hard 400.
 *
 * @see https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
 */

/**
 * Documented sentinel that makes Gemini skip thought signature validation for a
 * function call part we have no real signature for.
 */
export const THOUGHT_SIGNATURE_SKIP_SENTINEL = 'skip_thought_signature_validator';

function firstNonEmptyString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Read a thought signature off a tool call, wherever the caller put it.
 *
 * Checked in priority order:
 *   1. `metadata.thoughtSignature` — our own generic tool-calling format, set by
 *      GoogleConverter when parsing a Gemini response.
 *   2. `extra_content.google.thought_signature` — Google's documented
 *      OpenAI-compatibility location, what external callers of `/api/inference`
 *      get back from us and are expected to echo.
 *   3. A flat `thought_signature` / `thoughtSignature` on the call or its
 *      `function` object — used by some OpenAI-compatible clients in the wild.
 *
 * @param {Object} toolCall - Tool call in generic or OpenAI shape
 * @returns {string|undefined} The signature, or undefined if the call has none
 */
export function extractThoughtSignature(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return undefined;

  const extra = toolCall.extra_content ?? toolCall.extraContent;
  const google = extra && typeof extra === 'object' ? extra.google : undefined;

  return firstNonEmptyString(
    toolCall.metadata?.thoughtSignature,
    toolCall.metadata?.thought_signature,
    google?.thought_signature,
    google?.thoughtSignature,
    toolCall.thought_signature,
    toolCall.thoughtSignature,
    toolCall.function?.thought_signature,
    toolCall.function?.thoughtSignature
  );
}

/**
 * Build the `extra_content` payload that carries a thought signature across an
 * OpenAI-compatible boundary. Keeping the wire shape in one place means the
 * emit side and the accept side above can never drift apart.
 *
 * This exact shape is not just Google's documented convention, it is what real
 * OpenAI-compatible agents key on. Hermes Agent, for instance, captures
 * `extra_content` off each tool call and replays it whenever the model name
 * looks Gemini-family — while dropping every other unrecognised field. A
 * provider-neutral alias would therefore buy nothing.
 *
 * @param {string} signature - Thought signature to carry
 * @returns {{google: {thought_signature: string}}} extra_content value
 */
export function buildThoughtSignatureExtraContent(signature) {
  return { google: { thought_signature: signature } };
}

/**
 * Whether a model is one that consumes `extra_content` thought signatures, i.e.
 * a Gemini-family model — reached either through the native Google adapter or
 * through the `openai` adapter pointed at Gemini's OpenAI-compatible endpoint.
 *
 * The distinction matters on the way *out*: Gemini requires the field, while
 * strict OpenAI-compatible providers (Mistral, Fireworks, …) reject a request
 * that carries it. A caller replaying Gemini-originated history against a
 * different model would otherwise forward a field that fails the request.
 *
 * @param {Object} [model] - Model configuration
 * @returns {boolean} True when the target model consumes thought signatures
 */
export function modelConsumesThoughtSignature(model) {
  if (!model || typeof model !== 'object') return false;

  // Model naming is the primary signal — the same one Gemini-aware OpenAI
  // clients use. `modelId` is what actually goes on the wire, so an operator
  // pointing the `openai` adapter at Gemini's compatible endpoint still has a
  // Gemini name there even if the local `id` is an alias.
  const names = `${model.id || ''} ${model.modelId || ''}`.toLowerCase();
  if (names.includes('gemini') || names.includes('gemma')) return true;

  // A Google-hosted endpoint is conclusive on its own, whatever the model is
  // called locally.
  return String(model.url || '')
    .toLowerCase()
    .includes('googleapis.com');
}

/**
 * Drop the Gemini `extra_content` vendor extension from OpenAI-format tool
 * calls, leaving everything else untouched. Returns the original array when
 * there is nothing to strip so the common path allocates nothing.
 *
 * @param {Object[]} toolCalls - OpenAI-format tool calls
 * @returns {Object[]} Tool calls without `extra_content`
 */
export function stripThoughtSignatureExtraContent(toolCalls) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  if (!toolCalls.some(call => call && typeof call === 'object' && 'extra_content' in call)) {
    return toolCalls;
  }
  return toolCalls.map(call => {
    if (!call || typeof call !== 'object' || !('extra_content' in call)) return call;
    const { extra_content: _dropped, ...rest } = call;
    return rest;
  });
}

function hasStandardContent(message) {
  if (message.imageData || message.audioData) return true;

  const { content } = message;

  // Deliberately "non-empty", not "non-blank": the Google adapter forwards any
  // truthy string as a real `{ text: … }` user part, whitespace included, so
  // Gemini counts it as the standard content that opens a turn. Treating a
  // whitespace-only message as blank here would put the boundary at an older
  // user message and leak sentinels into function calls from a previous turn.
  if (typeof content === 'string') return content.length > 0;

  // OpenAI multipart content: any text part with text, or any non-text part
  // (image/audio/file) counts as standard content.
  if (Array.isArray(content)) {
    return content.some(part => {
      if (!part || typeof part !== 'object') return false;
      if (part.type === 'text') return typeof part.text === 'string' && part.text.length > 0;
      return true;
    });
  }

  return false;
}

/**
 * Index of the message that starts the current turn, mirroring how Gemini scopes
 * thought signature validation: walk the history newest to oldest and stop at
 * the most recent user message carrying standard content. Tool results (`role:
 * 'tool'`) are function responses, not turn boundaries, so they are skipped.
 *
 * @param {Object[]} messages - Conversation history in our internal/OpenAI shape
 * @returns {number} Index of the turn-opening user message, or -1 when there is
 *   none — in which case the whole history is the current turn.
 */
export function findCurrentTurnStartIndex(messages = []) {
  if (!Array.isArray(messages)) return -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    if (hasStandardContent(message)) return i;
  }

  return -1;
}
