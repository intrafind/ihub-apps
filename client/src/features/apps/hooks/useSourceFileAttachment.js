// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteChatFile,
  fetchChatArtifact,
  fetchSharedArtifact,
  uploadChatFile
} from '../../../api';
import { processCloudFile } from '../../upload/utils/cloudFileProcessing';
import { fileTypeOf } from '../../upload/utils/uploadFormats';
import { modelTakesFileKind } from '../../../shared/utils/modelInputCapabilities';
import { withStoredFile } from '../../chat/utils/chatFileUpload';
import { CHAT_ARTIFACT_SOURCE } from '../../chat/utils/useInApp';

/** The id under which this hook reports itself as busy to the composer. */
const BUSY_ID = 'source-file-attachment';

/**
 * The `detail` of an RFC 9457 problem answer, wherever the API client put it
 * (`handleApiResponse` wraps the axios error in `originalError`).
 *
 * @param {Object} error
 * @returns {string}
 */
export function problemDetailOf(error) {
  const data = error?.originalError?.response?.data || error?.response?.data;
  if (data && typeof data === 'object' && typeof data.detail === 'string') return data.detail;
  return '';
}

/**
 * Attach the file "Use in app…" handed over (`startChatHandoff`'s `attachment`)
 * to the composer of a new chat, the way a file picked from a cloud storage is
 * attached. Never sends.
 *
 * 1. **Copy on the server** (the rule): `POST /api/chats/{chatId}/files` with
 *    `{ appId, source: { kind, ref } }`. The server copies the generated file
 *    or the project document into this chat's file store, checks it against
 *    the app's upload policy and extracts its text; the composer gets the
 *    stored file (an id, like any pre-uploaded document). It takes the document
 *    types of a normal chat upload — ZIP archives are never handed over, and
 *    pictures only to an app whose chats recognize their text (#3986), where the
 *    stored file is that text (`canUseArtifactInApp`, `appsAcceptingFile`).
 * 2. **In the browser** (the exception): an installation that keeps no chat
 *    files on the server (`uploads.enabled` off) has no store to copy into. The
 *    bytes of a generated file are then fetched through its chat or its share
 *    and processed like a picked cloud file (`processCloudFile`). A project
 *    document needs the server.
 *
 * A refusal (uploads off for the app, a type it does not take, a document marked
 * "Not for AI", no access any more) is said in the chat with the server's
 * `detail`.
 *
 * @param {Object} options
 * @param {{key: number, attachment: import('../../chat/utils/useInApp').SourceAttachment}|null}
 *   options.pending - What to attach; a new `key` starts a new run.
 * @param {boolean} options.ready - This chat's app is loaded and its settings picked a model
 *   (`isChatReadyForDocument`): the chat id is the new chat's by then.
 * @param {string} [options.chatId]
 * @param {Object} options.app
 * @param {Object|null} options.currentModel
 * @param {Object} options.fileUploadHandler - `useFileUploadHandler()`
 * @param {(content: string, isError?: boolean) => void} options.addSystemMessage
 * @param {{enabled: boolean, ephemeral?: boolean}} options.serverFiles - Whether the chat keeps
 *   files on the server (`useChatFilePreUpload().enabled`), and whether it is temporary.
 * @param {(result: {attached: boolean}) => void} [options.onDone] - Called once a run ended,
 *   with whether the file was attached.
 * @returns {void}
 */
export default function useSourceFileAttachment({
  pending,
  ready,
  chatId,
  app,
  currentModel,
  fileUploadHandler,
  addSystemMessage,
  serverFiles,
  onDone
}) {
  const { t } = useTranslation();
  const liveRef = useRef({});
  // Read through a ref: a re-render must neither restart nor cancel a copy under way.
  useEffect(() => {
    liveRef.current = {
      pending,
      chatId,
      app,
      currentModel,
      fileUploadHandler,
      addSystemMessage,
      serverFiles,
      onDone,
      t
    };
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const key = pending?.key ?? null;
  const handledKeyRef = useRef(null);

  useEffect(() => {
    if (key === null || !ready || handledKeyRef.current === key) return;
    handledKeyRef.current = key;

    const run = async () => {
      const live = liveRef.current;
      // One registration per run: an earlier run that is still waiting must not
      // clear the busy state of a newer one when it ends.
      const busyId = `${BUSY_ID}:${key}`;
      let attached = false;
      const { attachment } = live.pending;
      const uploader = live.fileUploadHandler;
      const startedChatId = live.chatId;
      const startedAppId = live.app?.id;
      // The user left the chat (or another file was handed over) while this ran.
      const stale = () => {
        const now = liveRef.current;
        return (
          !mountedRef.current ||
          now.pending?.key !== key ||
          now.chatId !== startedChatId ||
          now.app?.id !== startedAppId
        );
      };
      const say = message => live.addSystemMessage?.(message, true);
      const type = fileTypeOf(attachment.mimeType, attachment.name);
      const fromArtifact = attachment.source?.kind === CHAT_ARTIFACT_SOURCE;

      let placeholder = null;
      const dropPlaceholder = () => {
        const handler = liveRef.current.fileUploadHandler;
        if (placeholder && handler?.selectedFile === placeholder) handler.clearSelectedFile();
      };

      try {
        uploader.setAttachmentProcessing?.(busyId, true);
        placeholder = {
          type: 'document',
          source: attachment.source.kind,
          fileName: attachment.name,
          fileSize: attachment.bytes || 0,
          fileType: type || 'application/octet-stream',
          loading: true
        };
        uploader.setSelectedFile(placeholder);

        // Whichever way the file is copied, the chat's model has to take documents
        // (a transcription model takes audio only: the message would never send).
        if (!modelTakesFileKind('document', live.currentModel)) {
          uploader.clearSelectedFile();
          say(
            live.t(
              'useInApp.attach.modelCannot',
              'The file could not be attached: the selected model cannot take this kind of file.'
            )
          );
          return undefined;
        }

        if (fromArtifact && !live.serverFiles?.enabled) {
          // By the chat it lives in, or by the share it was opened through.
          const { chatId: sourceChatId, shareId, artifactId } = attachment.source.ref;
          const blob = shareId
            ? await fetchSharedArtifact(shareId, artifactId)
            : await fetchChatArtifact(sourceChatId, artifactId);
          if (stale()) return dropPlaceholder();
          const file = new File([blob], attachment.name, { type: type || blob.type });
          const uploadConfig = uploader.createUploadConfig(live.app, live.currentModel) || {};
          const processed = await processCloudFile(file, uploadConfig);
          if (stale()) return dropPlaceholder();
          uploader.setSelectedFile({ ...processed, source: attachment.source.kind });
          attached = true;
          return undefined;
        }

        if (!live.serverFiles?.enabled || !startedChatId) {
          uploader.clearSelectedFile();
          say(
            live.t(
              'useInApp.attach.noServerFiles',
              'The document could not be attached: this installation does not keep chat files.'
            )
          );
          return undefined;
        }

        const stored = await uploadChatFile(
          startedChatId,
          { source: attachment.source },
          {
            fields: {
              ...(startedAppId ? { appId: startedAppId } : {}),
              ...(live.serverFiles.ephemeral ? { ephemeral: true } : {})
            }
          }
        );
        const descriptor = stored?.file || stored;
        if (!descriptor?.id) throw new Error('No file in the response');
        if (stale()) {
          // The chat moved on: do not leave the copy the server just made behind.
          deleteChatFile(startedChatId, descriptor.id).catch(() => {});
          return dropPlaceholder();
        }
        uploader.setSelectedFile(
          withStoredFile(
            {
              type: 'document',
              source: attachment.source.kind,
              chatId: startedChatId,
              fileName: descriptor.name || attachment.name,
              fileSize: descriptor.originalBytes || descriptor.bytes || attachment.bytes || 0,
              fileType: descriptor.mimeType || type || 'application/octet-stream'
            },
            descriptor
          )
        );
        attached = true;
        return undefined;
      } catch (error) {
        console.error('Failed to attach the handed-over file:', error);
        if (stale()) return dropPlaceholder();
        uploader.clearSelectedFile();
        const detail = problemDetailOf(error);
        say(
          detail
            ? live.t('useInApp.attach.refused', 'The file could not be attached: {{detail}}', {
                detail
              })
            : live.t('useInApp.attach.failed', 'The file could not be attached. Please try again.')
        );
        return undefined;
      } finally {
        uploader.setAttachmentProcessing?.(busyId, false);
        if (!stale()) liveRef.current.onDone?.({ attached });
      }
    };

    void run();
  }, [key, ready]);
}
