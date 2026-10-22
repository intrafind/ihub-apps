// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

/**
 * sessionStorage key of the container project of a chat that is not stored
 * server-side: kept beside its browser transcript, so a chat reopened from
 * that transcript stays inside its project (#1036).
 *
 * @param {string} chatId
 * @returns {string}
 */
export const chatProjectStorageKey = chatId => `ai_hub_chat_project_${chatId}`;

/**
 * The container project kept for a browser-persisted chat.
 *
 * @param {string} chatId
 * @returns {string|null}
 */
export function readChatProjectId(chatId) {
  try {
    return sessionStorage.getItem(chatProjectStorageKey(chatId)) || null;
  } catch {
    return null;
  }
}

/**
 * Keep (or, with no project, drop) the container project of a
 * browser-persisted chat.
 *
 * @param {string} chatId
 * @param {string|null} projectId
 */
export function writeChatProjectId(chatId, projectId) {
  try {
    if (projectId) sessionStorage.setItem(chatProjectStorageKey(chatId), projectId);
    else sessionStorage.removeItem(chatProjectStorageKey(chatId));
  } catch {
    // Storage blocked or full: the chat simply is not remembered in its project.
  }
}
