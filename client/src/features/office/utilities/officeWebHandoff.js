// "Open in web" for the Outlook task pane and the extension side panel: the
// pieces of the handoff that need no React. The pane's conversation lives only
// in the pane (every turn goes out `ephemeral`), so continuing it in the web app
// means storing a copy as a durable chat and opening that chat's URL.

/**
 * The part of the pane's transcript the web app can continue from.
 *
 * Only settled user and assistant turns: a greeting is not something anyone
 * said, a system line is the pane talking to itself, and a streaming, failed or
 * stopped answer has no content worth replaying. A user turn carries what the
 * model was actually sent (`rawContent`, when the pane kept it separately from
 * what it displayed), so the conversation continues the way it was going.
 *
 * The open email and its attachments are not part of the transcript — the pane
 * hands them to the model per turn, and the server stores none of it.
 *
 * @param {Array<Object>} messages - The pane's chat messages.
 * @returns {Array<{ role: 'user'|'assistant', content: string, ts?: string }>} Oldest first.
 */
export function buildImportMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const importable = [];
  for (const message of messages) {
    if (!message || message.isGreeting) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.loading || message.error || message.cancelled) continue;
    const content =
      message.role === 'user' && typeof message.rawContent === 'string'
        ? message.rawContent
        : message.content;
    if (typeof content !== 'string' || !content.trim()) continue;
    importable.push({
      role: message.role,
      content,
      ...(typeof message.ts === 'string' ? { ts: message.ts } : {})
    });
  }
  return importable;
}

/**
 * The web app's address for a stored chat — the route its history opens.
 *
 * `baseUrl` is the deployment's public URL including any base path (what the
 * add-in was installed from), so a subpath deployment needs no special case.
 *
 * @param {string} baseUrl - Public base URL, e.g. `https://ihub.example.com/ihub`.
 * @param {string} appId - App the chat belongs to.
 * @param {string} chatId - Stored chat id.
 * @returns {string|null} Absolute URL, or null when any part is missing.
 */
export function buildWebChatUrl(baseUrl, appId, chatId) {
  if (typeof baseUrl !== 'string' || !baseUrl || !appId || !chatId) return null;
  return `${baseUrl.replace(/\/+$/, '')}/apps/${encodeURIComponent(appId)}/c/${encodeURIComponent(chatId)}`;
}

/**
 * What went wrong with an import, as a key the pane can say something useful
 * about. The server's codes are the contract; anything else is "failed".
 *
 * The API layer (`handleApiResponse`) does not rethrow the axios error: it
 * throws a fresh one carrying `status` and the original as `originalError`,
 * and the server's response lives on that. A bare axios error is read too.
 *
 * @param {Error & {
 *   status?: number,
 *   response?: object,
 *   originalError?: { response?: { status?: number, data?: { details?: { code?: string } } } }
 * }} error
 * @returns {'unavailable'|'denied'|'tooLong'|'failed'}
 */
export function classifyImportError(error) {
  const response = error?.response ?? error?.originalError?.response;
  const status = response?.status ?? error?.status;
  const code = response?.data?.details?.code;
  if (code === 'CHAT_PERSISTENCE_UNAVAILABLE' || status === 503) return 'unavailable';
  if (code === 'APP_ACCESS_DENIED' || status === 403) return 'denied';
  if (code === 'TOO_MANY_MESSAGES') return 'tooLong';
  return 'failed';
}
