// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteChatFile,
  downloadChatArtifactsZip,
  fetchChatArtifact,
  fetchChatArtifacts,
  fetchChatFileBlob,
  fetchChatFileText,
  fetchChatFiles
} from '../../../../api';
import ArtifactViewerHost from '../../../chat/components/ArtifactViewerHost';
import ChatFilesContext from '../../../chat/contexts/ChatFilesContext';
import { attachStoredFileToMail, mailAttachState } from '../../../chat/utils/attachToMail';

/** A chat the server has no record of yet has no files: read as an empty list. */
const emptyWhenMissing = request =>
  request.catch(error => {
    if (error?.status === 404 || error?.response?.status === 404) return { items: [] };
    throw error;
  });

/**
 * The Files view of the Outlook task pane (and the browser extension's side panel).
 *
 * A card of a message that names a stored file, or a file the assistant generated, opens in
 * the same workspace pane the web app has. These surfaces never split: the pane is a
 * full-screen sheet over the chat with a "Back to chat" button — the uploaded files with their
 * preview, download and delete, and what the assistant generated. While a mail is being
 * written, "Attach to email" is a visible button of the header.
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
  const workspaceRef = useRef(null);
  // A chat that is left closes the pane.
  const shownChatRef = useRef(chatId);
  useEffect(() => {
    if (shownChatRef.current !== chatId) workspaceRef.current?.close();
    shownChatRef.current = chatId;
  }, [chatId]);

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
      openFile: fileId => workspaceRef.current?.openFile(fileId),
      fetchBlob: uploadedSource.fetchBlob
    }),
    [uploadedSource]
  );
  const files = useMemo(
    () => ({
      artifacts: artifactSource,
      uploaded: uploadedSource,
      mailAttach: mailAttachSource,
      zipName
    }),
    [artifactSource, uploadedSource, mailAttachSource, zipName]
  );

  return (
    <ChatFilesContext value={filesContext}>
      <ArtifactViewerHost
        messages={messages}
        chatId={chatId}
        files={files}
        forceSheet
        controllerRef={workspaceRef}
      >
        {children}
      </ArtifactViewerHost>
    </ChatFilesContext>
  );
}
