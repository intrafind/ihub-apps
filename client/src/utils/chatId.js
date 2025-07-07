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

