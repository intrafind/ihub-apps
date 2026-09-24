/**
 * Pending `ui/update-model-context` updates, per chat.
 *
 * A view may report its current state at any time; the specification says
 * each update replaces that view's previous one and only the latest reaches
 * the model, with the next user message. The chat hook takes the pending
 * updates when it sends a message and posts them as `mcpAppContext`; the
 * server appends them to that turn only.
 *
 * @module features/chat/mcpApps/modelContextStore
 */

/** Same cap the server enforces (services/mcp/mcpAppContext.js). */
const MAX_VIEWS = 10;

/** chatId -> Map(callId -> { toolId, content, structuredContent, at }) */
const pending = new Map();

/**
 * Record (replace) a view's latest model context.
 * @param {string} chatId
 * @param {string} callId - The view's tool call id
 * @param {string} toolId - iHub id of the tool that rendered the view
 * @param {{content?: Array, structuredContent?: Object}} update
 */
export function setMcpAppModelContext(chatId, callId, toolId, update) {
  if (!chatId || !callId) return;
  const content = Array.isArray(update?.content) ? update.content : undefined;
  const structuredContent =
    update?.structuredContent && typeof update.structuredContent === 'object'
      ? update.structuredContent
      : undefined;
  let views = pending.get(chatId);
  if (!content && !structuredContent) {
    views?.delete(callId);
    return;
  }
  if (!views) {
    views = new Map();
    pending.set(chatId, views);
  }
  views.set(callId, { toolId, content, structuredContent, at: Date.now() });
}

/**
 * Take — and clear — a chat's pending updates, newest first.
 * @param {string} chatId
 * @returns {Array<{toolId:string, content?:Array, structuredContent?:Object}>}
 */
export function takeMcpAppModelContext(chatId) {
  const views = pending.get(chatId);
  if (!views || views.size === 0) return [];
  pending.delete(chatId);
  return [...views.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_VIEWS)
    .map(({ toolId, content, structuredContent }) => ({
      toolId,
      ...(content ? { content } : {}),
      ...(structuredContent ? { structuredContent } : {})
    }));
}

/**
 * Drop a chat's pending updates (chat cleared or switched).
 * @param {string} chatId
 */
export function clearMcpAppModelContext(chatId) {
  pending.delete(chatId);
}
