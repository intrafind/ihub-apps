import { v4 as uuidv4 } from 'uuid';

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
