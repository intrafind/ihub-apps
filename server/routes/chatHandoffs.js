/**
 * Chat hand-off routes — continue a chat that is not stored server-side in
 * another window of the same user ("Open in web app" in the Outlook pane).
 *
 *   POST /api/chat-handoffs        { appId, messages, variables? }  park it → { token, expiresAt }
 *   POST /api/chat-handoffs/claim  { token }                        take it  → { appId, messages, variables }
 *
 * The pane parks the transcript with its bearer token and opens
 * `/apps/:appId?handoff=<token>` in the browser; the web app claims it with
 * the browser session. Both resolve to the same `req.user.id` (the pane's
 * OAuth token carries the web session's subject), and only that user can
 * claim. See `services/chat/chatHandoffStore.js` for why the record is
 * single-use, short-lived and in memory.
 *
 * Stored chats never come through here: the browser opens them by id.
 *
 * `authenticatedOnly`: a hand-off is owned, and an anonymous caller has no
 * identity a second window could prove.
 *
 * @module routes/chatHandoffs
 */
import { authenticatedOnly } from '../middleware/authRequired.js';
import { buildServerPath } from '../utils/basePath.js';
import { isValidId } from '../utils/pathSecurity.js';
import { sendBadRequest, sendErrorResponse } from '../utils/responseHelpers.js';
import logger from '../utils/logger.js';
import { claimHandoff, parkHandoff } from '../services/chat/chatHandoffStore.js';

/** Messages one hand-off carries at most. */
export const MAX_HANDOFF_MESSAGES = 200;

/** Characters one message's text carries at most (the chat store's cap). */
export const MAX_HANDOFF_MESSAGE_CHARS = 100_000;

/** Serialized size of one hand-off at most — the email rides along as text. */
export const MAX_HANDOFF_BYTES = 4 * 1024 * 1024;

/** App variables one hand-off carries at most. */
const MAX_HANDOFF_VARIABLES = 100;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Reduce a submitted hand-off to what the web app continues with, or explain
 * what is wrong with it.
 *
 * Kept per message: the role, the text, and — on a user message — the host
 * context (the email or meeting the turn was about), which the web app sends
 * back as history so the model still has the email the chat discussed.
 * Everything else a pane message carries (attachment bytes, display state)
 * is dropped.
 *
 * @param {Object} body - Request body.
 * @returns {{ value: Object }|{ error: string }}
 */
export function normalizeHandoff(body) {
  if (!isPlainObject(body)) return { error: 'Body must be an object' };
  const { appId, messages, variables } = body;

  if (typeof appId !== 'string' || !isValidId(appId)) return { error: 'Invalid appId' };
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'messages must be a non-empty array' };
  }
  if (messages.length > MAX_HANDOFF_MESSAGES) {
    return { error: `At most ${MAX_HANDOFF_MESSAGES} messages can be handed off` };
  }

  const normalized = [];
  for (const message of messages) {
    if (!isPlainObject(message)) return { error: 'Every message must be an object' };
    if (message.role !== 'user' && message.role !== 'assistant') {
      return { error: 'Message role must be "user" or "assistant"' };
    }
    if (typeof message.content !== 'string') return { error: 'Message content must be a string' };
    if (message.content.length > MAX_HANDOFF_MESSAGE_CHARS) {
      return { error: `Message content exceeds ${MAX_HANDOFF_MESSAGE_CHARS} characters` };
    }
    const entry = { role: message.role, content: message.content };
    if (message.role === 'user' && isPlainObject(message.hostContext)) {
      entry.hostContext = message.hostContext;
    }
    normalized.push(entry);
  }

  let normalizedVariables = null;
  if (variables !== undefined && variables !== null) {
    if (!isPlainObject(variables)) return { error: 'variables must be an object' };
    const entries = Object.entries(variables).filter(([, value]) =>
      ['string', 'number', 'boolean'].includes(typeof value)
    );
    if (entries.length > MAX_HANDOFF_VARIABLES) return { error: 'Too many variables' };
    normalizedVariables = Object.fromEntries(entries);
  }

  const value = { appId, messages: normalized, variables: normalizedVariables };
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > MAX_HANDOFF_BYTES) {
    return { error: 'The chat is too large to hand off', tooLarge: true };
  }
  return { value, bytes };
}

export default function registerChatHandoffRoutes(app) {
  app.post(buildServerPath('/api/chat-handoffs'), authenticatedOnly, (req, res) => {
    const result = normalizeHandoff(req.body);
    if (result.error) {
      if (result.tooLarge) {
        return sendErrorResponse(res, 413, result.error, {
          details: { code: 'HANDOFF_TOO_LARGE' }
        });
      }
      return sendBadRequest(res, result.error);
    }
    const { token, expiresAt } = parkHandoff(req.user.id, result.value, result.bytes);
    logger.info('Chat parked for hand-off', {
      component: 'ChatHandoff',
      appId: result.value.appId,
      messages: result.value.messages.length
    });
    return res.status(201).json({ token, expiresAt: new Date(expiresAt).toISOString() });
  });

  app.post(buildServerPath('/api/chat-handoffs/claim'), authenticatedOnly, async (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
      return sendBadRequest(res, 'Invalid token');
    }
    const result = await claimHandoff(token, req.user.id);
    if (result.error === 'notOwner') {
      return sendErrorResponse(res, 403, 'This chat was handed off by another user', {
        details: { code: 'HANDOFF_OTHER_USER' }
      });
    }
    if (result.error) {
      return sendErrorResponse(res, 404, 'Chat hand-off not found or expired', {
        details: { code: 'HANDOFF_NOT_FOUND' }
      });
    }
    return res.json(result.data);
  });
}
