/**
 * Pure context-window math — no heavy dependencies.
 *
 * Kept separate from `tokenEstimator.js` (which pulls in the gpt-tokenizer BPE
 * tables) so the client can import this lightweight helper eagerly while
 * loading the tokenizer itself lazily / on demand.
 */

/**
 * Compute remaining context-window capacity for a request.
 * @param {object} params
 * @param {number} params.contextWindow - model's total context window
 * @param {number} params.inputTokens - estimated input tokens
 * @param {number} params.maxOutputTokens - reserved output cap
 * @returns {{ contextWindow: number, inputTokens: number, maxOutputTokens: number, remaining: number, usedRatio: number }}
 */
export function computeContextUsage({ contextWindow, inputTokens, maxOutputTokens = 0 }) {
  const total = Number(contextWindow) || 0;
  const input = Number(inputTokens) || 0;
  const reserve = Number(maxOutputTokens) || 0;
  const remaining = total > 0 ? total - input - reserve : 0;
  const usedRatio = total > 0 ? (input + reserve) / total : 0;
  return {
    contextWindow: total,
    inputTokens: input,
    maxOutputTokens: reserve,
    remaining,
    usedRatio
  };
}

/**
 * Flatten one chat message into the text fragments that are actually sent to
 * the LLM.
 *
 * Mirrors what the client puts on the wire (`getMessagesForApi`: `rawContent`
 * wins over `content`) and what `RequestBuilder.preprocessMessagesWithFileData`
 * then folds into the message content (attached document text prefixed with a
 * `[File: name (type)]` header). Page images of image-based PDFs contribute a
 * header only — image tokens are provider-specific and not estimated here.
 *
 * @param {object} message - a chat message from the client's message list
 * @returns {Array<string>} text fragments contributed by this message
 */
export function messageTokenFragments(message) {
  if (!message || typeof message !== 'object') return [];

  const fragments = [];
  const content = message.rawContent !== undefined ? message.rawContent : message.content;
  if (typeof content === 'string' && content) fragments.push(content);

  const files = Array.isArray(message.fileData)
    ? message.fileData
    : message.fileData
      ? [message.fileData]
      : [];

  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const name = file.fileName || file.name || '';
    const type = file.displayType || file.fileType || file.type || '';
    fragments.push(`[File: ${name} (${type})]`);
    if (typeof file.content === 'string' && file.content) fragments.push(file.content);
  }

  return fragments;
}

/**
 * Flatten a whole conversation into the text fragments that will be sent with
 * the next turn.
 *
 * Every prior message is re-sent on each turn, so the context estimate has to
 * cover the full history — not just the pending message. Greeting messages are
 * UI-only and excluded, matching `getMessagesForApi`.
 *
 * @param {Array<object>} messages - the client's message list
 * @param {object} [options]
 * @param {boolean} [options.includeHistory=true] - false when the app/user has
 *   history disabled (`sendChatHistory`), in which case nothing is re-sent.
 * @returns {Array<string>} text fragments for the whole conversation
 */
export function conversationTokenFragments(messages = [], { includeHistory = true } = {}) {
  if (!includeHistory || !Array.isArray(messages)) return [];
  const fragments = [];
  for (const message of messages) {
    if (!message || message.isGreeting) continue;
    fragments.push(...messageTokenFragments(message));
  }
  return fragments;
}
