// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { resetChatId } from '../../utils/chatId';
import { setPendingChatStart } from './startChatHandoff';

/**
 * Open a new chat of an app with a file waiting to be attached ("Use in app…").
 *
 * The file is a server-side source (a generated file of a chat, a project
 * document): it rides the in-memory handoff (`setPendingChatStart`), and the
 * app's chat copies it into its own file store once it is loaded. Nothing is
 * sent: the user writes the message.
 *
 * The app's stored chat id is reset first, so the file lands in a new chat
 * also where chats are not kept in a history (there `/apps/:appId` reopens the
 * chat the tab holds for the app).
 *
 * @param {Object} options
 * @param {(path: string) => void} options.navigate - The router's `navigate`.
 * @param {string} options.appId - The app to open.
 * @param {import('./utils/useInApp').SourceAttachment} options.attachment
 * @returns {void}
 *
 * @example
 * openAppWithAttachment({ navigate, appId: 'summarizer', attachment });
 */
export function openAppWithAttachment({ navigate, appId, attachment }) {
  if (!appId || !attachment?.source) return;
  resetChatId(appId);
  setPendingChatStart({ appId, attachment });
  navigate(`/apps/${encodeURIComponent(appId)}`);
}
