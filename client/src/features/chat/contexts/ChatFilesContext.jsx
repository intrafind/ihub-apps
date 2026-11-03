// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * What a message bubble may do with the files of its chat: open one in the Files
 * drawer. Provided by the chat page; outside it (a shared chat, a preview) there
 * is no drawer to open and the chips stay plain labels.
 *
 * @type {import('react').Context<{ openFile: (fileId: string) => void }|null>}
 */
const ChatFilesContext = createContext(null);

export default ChatFilesContext;

/**
 * @returns {{ openFile: (fileId: string) => void }|null}
 */
export function useChatFiles() {
  return useContext(ChatFilesContext);
}
