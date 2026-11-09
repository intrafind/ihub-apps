// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  deleteChatFile,
  downloadChatArtifactsZip,
  fetchChatArtifact,
  fetchChatArtifacts,
  fetchChatFileBlob,
  fetchChatFileText,
  fetchChatFiles
} from '../../../../api';
import ChatFilesContext from '../../../chat/contexts/ChatFilesContext';
import { attachStoredFileToMail, mailAttachState } from '../../../chat/utils/attachToMail';

// Opened from a card only: most chats never open it
const ArtifactsPanel = lazy(() => import('../../../chat/components/ArtifactsPanel'));

/** A chat the server has no record of yet has no files: read as an empty list. */
const emptyWhenMissing = request =>
  request.catch(error => {
    if (error?.status === 404 || error?.response?.status === 404) return { items: [] };
    throw error;
  });

/**
 * The Files view of the Outlook task pane (and the browser extension's side panel).
 *
 * A card of a message that names a stored file used to be a plain card here: the pane had no
 * place to open it in. This gives it one, the same Files drawer the web app has, which on a
 * narrow surface is a full-pane sheet over the chat with its own close button: the uploaded
 * files with their preview, download and delete, and what the assistant generated. While a mail
 * is being written, a file can also be attached to it from there.
 *
 * It wraps the message list and offers it what a card needs: opening a file, and reading the
 * bytes of a stored picture for its thumbnail.
 *
 * @param {Object} props
 * @param {string} props.chatId - The chat whose files are shown.
 * @param {Object[]} [props.messages] - Its conversation, so the drawer can say which question a
 *   file came with and read the list again when the files change.
 * @param {string} [props.zipName] - Name of the archive of the generated files, without `.zip`.
 * @param {import('react').ReactNode} props.children - The message list.
 */
export default function OfficeFilesView({ chatId, messages = [], zipName = 'files', children }) {
  // Which file a card asked for, and in which chat: a chat that is left closes the view
  const [request, setRequest] = useState(null);
  const open = request !== null && request.chatId === chatId;

  const uploadedSource = useMemo(
    () => ({
      list: () => emptyWhenMissing(fetchChatFiles(chatId)),
      fetchText: fileId => fetchChatFileText(chatId, fileId),
      fetchBlob: fileId => fetchChatFileBlob(chatId, fileId),
      remove: fileId => deleteChatFile(chatId, fileId)
    }),
    [chatId]
  );
  const artifactSource = useMemo(
    () => ({
      list: () => emptyWhenMissing(fetchChatArtifacts(chatId)),
      fetchBlob: artifactId => fetchChatArtifact(chatId, artifactId),
      zip: artifactIds => downloadChatArtifactsZip(chatId, artifactIds)
    }),
    [chatId]
  );

  // "Attach to email" exists in the Outlook task pane and works while a mail is being written;
  // switching from a received mail to a draft changes the answer.
  const [mailAttach, setMailAttach] = useState(() => mailAttachState());
  useEffect(() => {
    if (!mailAttach.supported) return undefined;
    const refresh = () => setMailAttach(mailAttachState());
    document.addEventListener('ihub:itemchanged', refresh);
    return () => document.removeEventListener('ihub:itemchanged', refresh);
  }, [mailAttach.supported]);
  const mailAttachSource = useMemo(
    () => (mailAttach.supported ? { ...mailAttach, attach: attachStoredFileToMail } : null),
    [mailAttach]
  );

  const filesContext = useMemo(
    () => ({
      openFile: fileId => setRequest({ chatId, fileId }),
      fetchBlob: uploadedSource.fetchBlob
    }),
    [chatId, uploadedSource]
  );

  return (
    <ChatFilesContext value={filesContext}>
      {children}
      {open && (
        <Suspense fallback={null}>
          <ArtifactsPanel
            isOpen
            onClose={() => setRequest(null)}
            source={artifactSource}
            uploadedSource={uploadedSource}
            initialTab="uploaded"
            initialFileId={request.fileId}
            mailAttach={mailAttachSource}
            zipName={zipName}
            messages={messages}
          />
        </Suspense>
      )}
    </ChatFilesContext>
  );
}
