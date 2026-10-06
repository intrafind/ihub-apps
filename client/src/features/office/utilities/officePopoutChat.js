import { chatMessagesStorageKey } from '../../chat/utils/chatMessagesStorage';

/**
 * How a chat travels between the Outlook pane and its pop-out window (see
 * `officePopout.js`): `OfficeChatPanel` reports the chat as
 * `{ app, chatId, fresh, chatStored, transcript, variables, inputValue,
 * pinnedEmails }`, and the window that takes it over opens it with these.
 */

/**
 * The route state that opens a chat moved between the pane and the pop-out
 * window: the chat itself (a chat with nothing sent yet starts over as a new
 * one, which the store has never heard of) and what it had besides its
 * transcript.
 *
 * @param {object} state - What `OfficeChatPanel` reported for the chat.
 * @returns {{ chatId?: string, restoredChat: object }}
 */
export function popoutChatRouteState(state) {
  return {
    ...(state?.chatId && !state.fresh ? { chatId: state.chatId } : {}),
    restoredChat: {
      variables: state?.variables ?? null,
      inputValue: typeof state?.inputValue === 'string' ? state.inputValue : '',
      pinnedEmails: Array.isArray(state?.pinnedEmails) ? state.pinnedEmails : []
    }
  };
}

/**
 * Put a chat that is not stored server-side into this window's session
 * storage, where its transcript is read from when the chat opens.
 *
 * @param {object} state - What `OfficeChatPanel` reported for the chat.
 */
export function seedPopoutTranscript(state) {
  if (!state?.chatId || state.chatStored) return;
  try {
    const key = chatMessagesStorageKey(state.chatId);
    if (typeof state.transcript === 'string' && state.transcript) {
      sessionStorage.setItem(key, state.transcript);
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    // No session storage: the chat opens without its earlier messages.
  }
}
