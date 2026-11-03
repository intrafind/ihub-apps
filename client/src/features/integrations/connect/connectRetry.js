// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Retry once after connecting" (#2917, product concept §7.3).
 *
 * A call that failed **before** it ran, because the user had no usable
 * connection (`INTEGRATION_AUTH_REQUIRED`), left a Connect card on its
 * answer. When the user connects from that card, the browser comes back to
 * the same chat with `integration_connected=<id>`, and the chat asks the
 * assistant once to try again: one follow-up message, sent automatically,
 * only when
 *
 *   - the answer with the card for that integration is the **last** message
 *     of the chat (the user has not moved on), and
 *   - this answer has not been retried before (a reload, a second tab or a
 *     second connect does not send it again).
 *
 * A call that failed inside the adapter or on the transport never produced a
 * card (its result is not `INTEGRATION_AUTH_REQUIRED`), so it is never
 * retried automatically: a write may already have happened.
 *
 * Pure functions; the hook that wires them into the chat is
 * `useConnectRetry.js`.
 *
 * @module features/integrations/connect/connectRetry
 */
import { normalizeAuthPrompts } from './authPrompts';

/** Prefix of the session storage keys that remember a retried answer. */
export const RETRY_KEY_PREFIX = 'ihub.integrationRetry.';

/** In-memory record for when session storage is unavailable. */
const retriedInMemory = new Set();

/**
 * The answer whose call should be retried after connecting an integration,
 * or null.
 *
 * @param {Array<Object>} messages - The chat's messages, oldest first
 * @param {string} integrationId - The installation just connected
 * @returns {{messageId: string, prompt: import('./authPrompts').AuthPrompt}|null}
 *
 * @example
 * findRetryTarget(
 *   [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant',
 *     integrationAuthRequired: [{ integration: 'jira', name: 'Jira', reason: 'not_connected' }] }],
 *   'jira'
 * ); // → { messageId: 'a1', prompt: { integration: 'jira', … } }
 */
export function findRetryTarget(messages, integrationId) {
  if (!Array.isArray(messages) || !integrationId) return null;
  // System notices (errors, hints) do not count as the user moving on.
  const conversation = messages.filter(m => m && (m.role === 'user' || m.role === 'assistant'));
  const last = conversation[conversation.length - 1];
  if (!last || last.role !== 'assistant' || last.loading || !last.id) return null;
  const prompt = normalizeAuthPrompts(last.integrationAuthRequired).find(
    p => p.integration === integrationId
  );
  return prompt ? { messageId: String(last.id), prompt } : null;
}

/** The storage key of one answer's retry. */
export function retryKey(chatId, messageId) {
  return `${RETRY_KEY_PREFIX}${chatId || 'chat'}.${messageId}`;
}

/**
 * The storage to use: the one passed, else the session storage. Reading
 * `sessionStorage` itself throws (`SecurityError`) where the browser blocks
 * storage, so callers do it inside their `try`.
 *
 * @param {Storage|null|undefined} storage
 * @returns {Storage|null|undefined}
 */
function storageOf(storage) {
  return storage === undefined ? globalThis.sessionStorage : storage;
}

/**
 * Whether an answer was already retried.
 * @param {string} key - {@link retryKey}
 * @param {Storage|null} [storage] - Defaults to the session storage
 * @returns {boolean}
 */
export function wasRetried(key, storage) {
  if (retriedInMemory.has(key)) return true;
  try {
    return storageOf(storage)?.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Remember that an answer was retried, once the retry was sent.
 * @param {string} key - {@link retryKey}
 * @param {Storage|null} [storage] - Defaults to the session storage
 */
export function markRetried(key, storage) {
  retriedInMemory.add(key);
  try {
    storageOf(storage)?.setItem(key, '1');
  } catch {
    /* private mode: the in-memory record still holds for this page */
  }
}

/**
 * Decide the one retry, without claiming it. Returns the target and its
 * storage key when the caller should send the retry now, else null; the
 * caller marks it ({@link markRetried}) once the chat took the message.
 *
 * @param {Object} params
 * @param {string|null} params.connected - `integration_connected` of this page
 * @param {string} params.chatId
 * @param {Array<Object>} params.messages
 * @param {Storage|null} [params.storage]
 * @returns {{messageId: string, prompt: import('./authPrompts').AuthPrompt, key: string}|null}
 */
export function pendingRetry({ connected, chatId, messages, storage }) {
  if (!connected) return null;
  const target = findRetryTarget(messages, connected);
  if (!target) return null;
  const key = retryKey(chatId, target.messageId);
  return wasRetried(key, storage) ? null : { ...target, key };
}

/** Test seam: forget the in-memory record. */
export function resetConnectRetryForTests() {
  retriedInMemory.clear();
}
