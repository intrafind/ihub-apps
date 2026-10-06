/**
 * sessionStorage key of a chat's browser copy — the transcript of a chat that
 * is not stored server-side (`useChatMessages`). Its own module, free of
 * imports, for the code that hands such a chat to another window (the Outlook
 * pane's pop-out) and has to carry the transcript along.
 *
 * @param {string} chatId
 * @returns {string}
 */
export const chatMessagesStorageKey = chatId => `ai_hub_chat_messages_${chatId}`;
