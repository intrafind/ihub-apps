/**
 * Conversations of the inference API — an OpenAI conversation *is* an iHub
 * chat.
 *
 * The id is the chat id (no `conv_` prefix: OpenAI's prefixes only name the
 * object type, and the SDKs do not require them), the items are the chat's
 * stored messages, ownership is the chat's (`authorizeChat`), and a chat made
 * through the API shows up in its owner's chat history like any other. For an
 * OAuth client-credentials caller the owner is the technical client.
 *
 * A conversation is not tied to an app when it is created. The first response
 * run in it binds it to the app part of its `model` (or to "plain model");
 * later responses for a different app are refused, while switching the real
 * model under the same app is fine, as it is in the UI.
 *
 * @module services/inference/conversations
 */
import configCache from '../../configCache.js';
import runLog from '../loop/RunLog.js';
import { resolvePrincipal, isAnonymousUser } from '../loop/runIdentity.js';
import { authorizeChat } from '../chat/chatAccess.js';
import { getChatRepository, isPersistableChatId } from '../chat/ChatRepository.js';
import { isChatPersistenceConfigured } from '../chat/chatPersistence.js';
import { hasActiveChatRequest, isChatDurable } from '../../sse.js';
import { InferenceApiError } from './errors.js';

/** `origin.createdVia` of a chat made through the Responses / Conversations API. */
export const API_CREATED_VIA = 'responses-api';

/** OpenAI's bounds on conversation metadata. */
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_KEY_CHARS = 64;
const MAX_METADATA_VALUE_CHARS = 512;

/** Items `POST /conversations` and `POST /conversations/{id}/items` take at once. */
export const MAX_ITEMS_PER_REQUEST = 20;

/**
 * How long a freshly claimed run counts as alive before it has registered as
 * in flight. Past this, a chat that says `running` with nothing in flight
 * anywhere in the cluster was left behind by a process that died.
 */
const CLAIM_GRACE_MS = 30_000;

/**
 * The chat repository, when conversations can be stored for this caller.
 *
 * @param {Object|null} user
 * @returns {import('../chat/ChatRepository.js').ChatRepository}
 * @throws {InferenceApiError} 401 for an anonymous caller, 503 when chat persistence is off.
 */
export function requireConversations(user) {
  if (isAnonymousUser(user)) {
    throw new InferenceApiError(
      401,
      'authentication_required',
      'Conversations are stored per caller and need an authenticated caller'
    );
  }
  const repository = getChatRepository();
  const configured = isChatPersistenceConfigured(
    configCache.getFeatures(),
    configCache.getPlatform() || {}
  );
  if (!configured || !repository.isAvailable()) {
    throw new InferenceApiError(
      503,
      'conversations_unavailable',
      'Conversations are not available: chat persistence is switched off on this installation'
    );
  }
  return repository;
}

/**
 * The owner a chat created by this caller gets, in the ledger's identity mode.
 *
 * @param {Object} user
 * @returns {Promise<{id: string, mode: string}>}
 */
export async function ownerOf(user) {
  const mode = runLog.identityMode();
  const principal = await resolvePrincipal(user, { mode });
  return { id: principal.id, mode: principal.mode || mode };
}

/**
 * How a chat created through the API came about, recorded on the chat.
 *
 * @param {Object} user
 * @returns {{createdVia: string, clientId?: string, authMode?: string}}
 */
export function apiOrigin(user) {
  const clientId = user?.isOAuthClient ? user.id : user?.clientId;
  return {
    createdVia: API_CREATED_VIA,
    ...(clientId ? { clientId: String(clientId) } : {}),
    ...(user?.authMode ? { authMode: String(user.authMode) } : {})
  };
}

/**
 * Validate caller-defined conversation metadata (OpenAI's bounds: 16 keys,
 * keys up to 64 and string values up to 512 characters).
 *
 * @param {unknown} metadata
 * @param {string} [param='metadata']
 * @returns {Object<string, string>|null} null when absent.
 * @throws {InferenceApiError}
 */
export function validateMetadata(metadata, param = 'metadata') {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new InferenceApiError(400, 'invalid_metadata', `${param} must be an object`, { param });
  }
  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new InferenceApiError(
      400,
      'invalid_metadata',
      `${param} may have at most ${MAX_METADATA_KEYS} keys`,
      { param }
    );
  }
  for (const [key, value] of entries) {
    if (key.length > MAX_METADATA_KEY_CHARS) {
      throw new InferenceApiError(
        400,
        'invalid_metadata',
        `${param} keys may be at most ${MAX_METADATA_KEY_CHARS} characters`,
        { param }
      );
    }
    if (typeof value !== 'string' || value.length > MAX_METADATA_VALUE_CHARS) {
      throw new InferenceApiError(
        400,
        'invalid_metadata',
        `${param}.${key} must be a string of at most ${MAX_METADATA_VALUE_CHARS} characters`,
        { param: `${param}.${key}` }
      );
    }
  }
  return { ...metadata };
}

/**
 * The conversation id a `/responses` request names: a string, or `{ id }`.
 *
 * @param {unknown} conversation
 * @returns {string|null}
 * @throws {InferenceApiError}
 */
export function conversationIdOf(conversation) {
  if (conversation === undefined || conversation === null) return null;
  const id = typeof conversation === 'object' ? conversation.id : conversation;
  if (typeof id !== 'string' || !id) {
    throw new InferenceApiError(
      400,
      'invalid_conversation',
      'conversation must be a conversation id or { id }',
      { param: 'conversation' }
    );
  }
  return id;
}

/**
 * Load a conversation the caller owns.
 *
 * @param {import('../chat/ChatRepository.js').ChatRepository} repository
 * @param {string} id
 * @param {Object} user
 * @param {'read'|'write'} [intent='read']
 * @returns {Promise<Object>} The chat.
 * @throws {InferenceApiError} 404 for an unknown id and for someone else's chat alike.
 */
export async function loadConversation(repository, id, user, intent = 'read') {
  const notFound = new InferenceApiError(
    404,
    'conversation_not_found',
    `Conversation not found: ${id}`,
    {
      param: 'conversation'
    }
  );
  if (!isPersistableChatId(id)) throw notFound;
  const access = await authorizeChat(id, user, { repository, intent });
  if (!access.ok || !access.chat) throw notFound;
  return access.chat;
}

const toUnix = iso => {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
};

/**
 * The OpenAI conversation object of a chat.
 *
 * @param {Object} chat
 * @returns {{id: string, object: 'conversation', created_at: number, metadata: Object}}
 */
export function conversationObject(chat) {
  return {
    id: chat.id,
    object: 'conversation',
    created_at: toUnix(chat.createdAt),
    metadata: chat.metadata && typeof chat.metadata === 'object' ? chat.metadata : {}
  };
}

/**
 * The conversation item of a stored message.
 *
 * A user item's content is the raw input (the variables it was rendered with
 * go in `metadata`); an assistant item carries the validated structured
 * output as `parsed` beside its text — the stored JSON, not text parsed again.
 *
 * @param {Object} message - Stored chat message.
 * @returns {Object}
 */
export function itemFromMessage(message) {
  const role = message.role === 'assistant' ? 'assistant' : message.role || 'user';
  if (role === 'assistant') {
    const hasOutput = message.output !== undefined && message.output !== null;
    const metadata = {
      ...(message.model ? { model: message.model } : {}),
      ...(message.error ? { error: message.error } : {}),
      // EU AI Act provenance recorded when the answer was generated.
      ...(message.provenance ? { provenance: message.provenance } : {})
    };
    return {
      type: 'message',
      id: message.id,
      status: message.error ? 'incomplete' : 'completed',
      role,
      content: [
        {
          type: 'output_text',
          text: message.content || '',
          annotations: [],
          ...(hasOutput ? { parsed: message.output } : {})
        }
      ],
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      created_at: toUnix(message.ts)
    };
  }
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return {
    type: 'message',
    id: message.id,
    status: 'completed',
    role,
    content: [
      { type: 'input_text', text: message.content || '' },
      ...attachments.map(attachment =>
        attachment.type?.startsWith('image/')
          ? { type: 'input_image', ...(attachment.name ? { filename: attachment.name } : {}) }
          : { type: 'input_file', ...(attachment.name ? { filename: attachment.name } : {}) }
      )
    ],
    ...(message.variables && Object.keys(message.variables).length > 0
      ? { metadata: { variables: message.variables } }
      : {}),
    created_at: toUnix(message.ts)
  };
}

/**
 * The stored history as the model sees it: user turns as they were rendered
 * (template, variables and document text included), answers as stored.
 * Failed and empty turns are left out — an error must not steer the next
 * answer, and providers reject blank messages.
 *
 * @param {Array<Object>} messages - Stored messages.
 * @returns {Array<{role: string, content: string}>}
 */
export function historyForModel(messages) {
  const out = [];
  for (const message of messages || []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    if (message.role === 'assistant' && message.error) continue;
    const content =
      message.role === 'user' && typeof message.renderedContent === 'string'
        ? message.renderedContent
        : message.content;
    if (typeof content !== 'string' || !content.trim()) continue;
    out.push({ role: message.role, content });
  }
  return out;
}

/**
 * Whether no answer has been given in this conversation yet. Only an answer
 * a turn produced counts: assistant items added through the items endpoint
 * (seeded history, few-shot examples) carry no run, and do not make the next
 * turn a follow-up.
 */
export function isFirstTurn(messages) {
  return !(messages || []).some(message => message?.role === 'assistant' && message?.runId);
}

/**
 * What the conversation is bound to: `{ type: 'app', appId }`, `{ type:
 * 'model' }`, or null while no response has run. A chat started in the UI is
 * bound to its app.
 *
 * @param {Object} chat
 * @returns {{type: 'app', appId: string}|{type: 'model'}|null}
 */
export function bindingOf(chat) {
  if (chat?.binding === 'model') return { type: 'model' };
  if (chat?.appId) return { type: 'app', appId: chat.appId };
  return null;
}

/**
 * Refuse a response for a different app than the conversation's.
 *
 * @param {Object} chat
 * @param {Object} target - Resolved `model`.
 * @throws {InferenceApiError} 400 `conversation_app_mismatch`.
 */
export function assertBinding(chat, target) {
  const bound = bindingOf(chat);
  if (!bound) return;
  if (bound.type === 'app') {
    if (target.kind === 'app' && target.app.id === bound.appId) return;
    throw new InferenceApiError(
      400,
      'conversation_app_mismatch',
      `Conversation ${chat.id} belongs to app ${bound.appId}; use model app:${bound.appId}[/<modelId>]`,
      { param: 'model' }
    );
  }
  if (target.kind === 'model') return;
  throw new InferenceApiError(
    400,
    'conversation_app_mismatch',
    `Conversation ${chat.id} was started with a plain model and cannot switch to an app`,
    { param: 'model' }
  );
}

/**
 * The chat fields that bind a conversation to a target.
 *
 * @param {Object} target
 * @returns {{appId: string|null, binding: 'app'|'model'}}
 */
export function bindingPatch(target) {
  return target.kind === 'app'
    ? { appId: target.app.id, binding: 'app' }
    : { appId: null, binding: 'model' };
}

/**
 * Whether the run a chat names as active is still alive: in flight anywhere
 * in the cluster, or claimed so recently it may not have registered yet.
 *
 * @param {string} chatId
 * @returns {(chat: Object) => boolean}
 */
export function runStillAlive(chatId) {
  return chat => {
    if (hasActiveChatRequest(chatId) || isChatDurable(chatId)) return true;
    const since = Date.parse(chat.runClaimedAt || chat.lastMessageAt || '');
    return Number.isFinite(since) && Date.now() - since < CLAIM_GRACE_MS;
  };
}

/**
 * Items to add to a conversation → messages to store. Only text messages of
 * the user and the assistant: a stored item has to be replayable to any
 * model later, and a file's content is extracted only when a response runs.
 *
 * @param {unknown} items
 * @param {string} [param='items']
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 * @throws {InferenceApiError}
 */
export function messagesFromItems(items, param = 'items') {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) {
    throw new InferenceApiError(400, 'invalid_items', `${param} must be an array`, { param });
  }
  if (items.length > MAX_ITEMS_PER_REQUEST) {
    throw new InferenceApiError(
      400,
      'invalid_items',
      `${param} may hold at most ${MAX_ITEMS_PER_REQUEST} items`,
      { param }
    );
  }
  return items.map((item, index) => {
    const at = `${param}[${index}]`;
    if (!item || typeof item !== 'object' || (item.type !== undefined && item.type !== 'message')) {
      throw new InferenceApiError(
        400,
        'unsupported_input_item',
        `${at}: only message items can be added`,
        {
          param: at
        }
      );
    }
    if (item.role !== 'user' && item.role !== 'assistant') {
      throw new InferenceApiError(400, 'invalid_items', `${at}.role must be user or assistant`, {
        param: `${at}.role`
      });
    }
    let text;
    if (typeof item.content === 'string') text = item.content;
    else if (Array.isArray(item.content)) {
      text = item.content
        .map((part, p) => {
          if (
            ['input_text', 'output_text', 'text'].includes(part?.type) &&
            typeof part.text === 'string'
          ) {
            return part.text;
          }
          throw new InferenceApiError(
            400,
            'unsupported_content_part',
            `${at}.content[${p}]: items added to a conversation carry text only; send files with a response`,
            { param: `${at}.content[${p}]` }
          );
        })
        .join('\n');
    } else {
      throw new InferenceApiError(
        400,
        'invalid_items',
        `${at}.content must be a string or an array`,
        {
          param: `${at}.content`
        }
      );
    }
    return { role: item.role, content: text };
  });
}
