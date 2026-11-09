// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * What a message bubble may do with the files of its chat: open one in the Files
 * drawer, and fetch the bytes of one (the thumbnail of a picture that was stored). Provided
 * by the chat page, and by a shared chat for the files its owner shared; outside them (a
 * preview) there is no drawer to open and the chips stay plain labels.
 *
 * @type {import('react').Context<{
 *   openFile: (fileId: string) => void,
 *   fetchBlob?: (fileId: string) => Promise<Blob>
 * }|null>}
 */
const ChatFilesContext = createContext(null);

export default ChatFilesContext;

/**
 * @returns {{ openFile: (fileId: string) => void, fetchBlob?: (fileId: string) => Promise<Blob> }|null}
 */
export function useChatFiles() {
  return useContext(ChatFilesContext);
}
