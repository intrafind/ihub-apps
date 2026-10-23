// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { v4 as uuidv4 } from 'uuid';

/**
 * A new chat id that is not stored anywhere. For surfaces that must not share
 * this tab's chat with the app page, such as the admin app editor's test panel.
 *
 * @param {string} [prefix='chat'] - Prefix for the generated id
 * @returns {string} The chat id
 */
export const mintChatId = (prefix = 'chat') => `${prefix}-${uuidv4()}`;

/**
 * Retrieve a chat ID for the given app from sessionStorage or generate a new one.
 * A new ID will only be created if none is stored.
 *
 * @param {string} appId - The app identifier
 * @param {string} [prefix='chat'] - Prefix for the generated id
 * @returns {string} The chat id
 */
export const getOrCreateChatId = (appId, prefix = 'chat') => {
  const key = `ai_hub_${prefix}_id_${appId}`;
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = `${prefix}-${uuidv4()}`;
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch (err) {
    console.error('Error accessing sessionStorage for chat id:', err);
    return `${prefix}-${uuidv4()}`;
  }
};

/**
 * The chat id this tab already holds for an app, without minting one.
 *
 * `getOrCreateChatId` cannot tell a caller whether it read or created, and the
 * difference matters: an id this tab just minted cannot exist in the durable
 * chat store, so fetching it can only ever 404.
 *
 * @param {string} appId - The app identifier
 * @param {string} [prefix='chat'] - Prefix the id was stored under
 * @returns {string|null} The stored chat id, or null when there is none
 */
export const readChatId = (appId, prefix = 'chat') => {
  const key = `ai_hub_${prefix}_id_${appId}`;
  try {
    return sessionStorage.getItem(key) || null;
  } catch (err) {
    console.error('Error accessing sessionStorage for chat id:', err);
    return null;
  }
};

/** Who the chat ids this tab holds were minted for. */
const CHAT_IDS_OWNER_KEY = 'ai_hub_chat_ids_owner';

/** The per-app chat id keys `getOrCreateChatId` writes, whatever the prefix. */
const CHAT_ID_KEY_PATTERN = /^ai_hub_[A-Za-z0-9-]+_id_/;

/**
 * Tie the chat ids this tab remembers to the user it remembers them for.
 *
 * Every chat is stored under its owner, so a remembered id is only good for
 * the user who started the chat: when the same tab becomes somebody else (an
 * anonymous visitor signs in, or another account does), the old ids would
 * hydrate as empty and refuse the next message. They are forgotten instead,
 * and the next visit to an app starts a new chat. Logging out clears the
 * whole of `sessionStorage` already.
 *
 * @param {string} userKey - The current user's id, `anonymous` for a visitor.
 */
export const bindChatIdsToUser = userKey => {
  try {
    const previous = sessionStorage.getItem(CHAT_IDS_OWNER_KEY);
    if (previous && previous !== userKey) {
      Object.keys(sessionStorage)
        .filter(key => CHAT_ID_KEY_PATTERN.test(key))
        .forEach(key => sessionStorage.removeItem(key));
    }
    sessionStorage.setItem(CHAT_IDS_OWNER_KEY, userKey);
  } catch {
    // No session storage: there are no remembered ids to forget either.
  }
};

/**
 * Get persisted conversation ID for an app from localStorage.
 * Used for iAssistant Conversation API to resume conversations across sessions.
 *
 * @param {string} appId - The app identifier
 * @returns {string|null} The conversation ID or null
 */
export const getConversationId = appId => {
  const key = `ai_hub_conversation_id_${appId}`;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * Persist a conversation ID for an app in localStorage.
 *
 * @param {string} appId - The app identifier
 * @param {string} conversationId - The conversation ID to persist
 */
export const setConversationId = (appId, conversationId) => {
  const key = `ai_hub_conversation_id_${appId}`;
  try {
    if (conversationId) {
      localStorage.setItem(key, conversationId);
    } else {
      localStorage.removeItem(key);
    }
  } catch (err) {
    console.error('Error persisting conversation ID:', err);
  }
};

/**
 * Clear persisted conversation ID for an app.
 *
 * @param {string} appId - The app identifier
 */
export const clearConversationId = appId => {
  const key = `ai_hub_conversation_id_${appId}`;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

/**
 * Reset the stored chat ID for the given app.
 *
 * @param {string} appId - The app identifier
 * @param {string} [prefix='chat'] - Prefix for the generated id
 * @returns {string} The new chat id
 */
export const resetChatId = (appId, prefix = 'chat') => {
  const key = `ai_hub_${prefix}_id_${appId}`;
  try {
    const id = `${prefix}-${uuidv4()}`;
    sessionStorage.setItem(key, id);
    return id;
  } catch (err) {
    console.error('Error resetting chat id in sessionStorage:', err);
    return `${prefix}-${uuidv4()}`;
  }
};
