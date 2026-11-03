// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef } from 'react';
import { deleteChatFile, uploadChatFile } from '../../../api';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import {
  buildUploadPayload,
  entryKey,
  needsPreUpload,
  preUploadAvailable,
  resolveUploadMode,
  updateSelection,
  uploadErrorCode,
  withStoredFile
} from '../utils/chatFileUpload';

const BUSY_ID = 'chat-file-upload';

/**
 * Upload the documents attached in the composer to the chat's file store as
 * soon as they are attached, with a progress value on each entry
 * (`uploadState`: `uploading` | `done` | `error`, `uploadProgress`: 0–100).
 *
 * A finished upload gives the entry a `fileId` and `serverStored: true`; the
 * message then names the file by id instead of carrying it. An upload that is
 * refused (a quota, a type the server cannot read) leaves the entry as it was
 * with `uploadState: 'error'`: it is still sent inline, as before the server
 * kept chat files, and the server stores it from the message.
 *
 * The send button is held back while an upload runs (`setAttachmentProcessing`),
 * and a file the user removes from the composer is removed from the server too.
 *
 * @param {Object} params
 * @param {string|null} params.chatId
 * @param {Object} [params.app] - For `app.uploads.storageMode` and the app id the server resolves quotas for.
 * @param {Object|Object[]|null} params.selectedFile - The composer's selection.
 * @param {Function} params.setSelectedFile - Raw state setter of the selection (accepts an updater).
 * @param {(id: string, busy: boolean) => void} [params.setAttachmentProcessing]
 * @param {boolean} [params.ephemeral] - Whether the chat is temporary (creates it as such).
 * @returns {{ handleFileSelect: (next: Object|Object[]|null) => void, enabled: boolean, mode: string }}
 *   `handleFileSelect` replaces the composer's own `onFileSelect`.
 */
export default function useChatFilePreUpload({
  chatId,
  app,
  selectedFile,
  setSelectedFile,
  setAttachmentProcessing,
  ephemeral = false
}) {
  const { platformConfig } = usePlatformConfig();
  const uploads = platformConfig?.uploads;
  const enabled = preUploadAvailable({ uploads, chatId });
  const mode = resolveUploadMode(uploads, app);

  const running = useRef(new Map()); // entryKey → AbortController
  // entryKey → descriptor of what the server stored. The uploader hands back
  // copies of the entries it knows, which do not carry the upload result: those
  // are given it again instead of uploading the file a second time.
  const stored = useRef(new Map());
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const selectionRef = useRef(selectedFile);
  selectionRef.current = selectedFile;

  // Read through a ref: a caller that passes a new function every render must
  // not stop the uploads (the cleanup below runs when its dependencies change).
  const setBusyRef = useRef(setAttachmentProcessing);
  setBusyRef.current = setAttachmentProcessing;
  const reportBusy = useCallback(() => {
    setBusyRef.current?.(BUSY_ID, running.current.size > 0);
  }, []);

  const start = useCallback(
    entry => {
      const key = entryKey(entry);
      if (running.current.has(key)) return;
      const payload = buildUploadPayload(entry, mode);
      if (!payload) return;

      const controller = new AbortController();
      running.current.set(key, controller);
      reportBusy();
      const patch = changes =>
        setSelectedFile(prev => updateSelection(prev, key, e => ({ ...e, ...changes })));
      patch({ uploadState: 'uploading', uploadProgress: 0, uploadError: undefined });

      let lastShown = 0;
      uploadChatFile(chatId, payload, {
        signal: controller.signal,
        fields: {
          ...(app?.id ? { appId: app.id } : {}),
          ...(ephemeral ? { ephemeral: true } : {})
        },
        onProgress: percent => {
          if (percent - lastShown < 5 && percent < 100) return;
          lastShown = percent;
          patch({ uploadProgress: percent });
        }
      })
        .then(result => {
          const descriptor = result?.file;
          if (!descriptor?.id) throw new Error('No file in the response');
          stored.current.set(key, descriptor);
          setSelectedFile(prev => updateSelection(prev, key, e => withStoredFile(e, descriptor)));
        })
        .catch(error => {
          if (controller.signal.aborted) return;
          patch({
            uploadState: 'error',
            uploadProgress: undefined,
            uploadError: uploadErrorCode(error)
          });
        })
        .finally(() => {
          running.current.delete(key);
          reportBusy();
        });
    },
    [app?.id, chatId, ephemeral, mode, reportBusy, setSelectedFile]
  );

  // Start an upload for every document that is not on the server yet.
  useEffect(() => {
    if (!enabled) return;
    for (const entry of [selectedFile].flat().filter(Boolean)) {
      if (!needsPreUpload(entry)) continue;
      const key = entryKey(entry);
      const done = stored.current.get(key);
      if (done) {
        setSelectedFile(prev =>
          updateSelection(prev, key, e => (e.fileId ? e : withStoredFile(e, done)))
        );
      } else {
        start(entry);
      }
    }
  }, [enabled, selectedFile, setSelectedFile, start]);

  // Leaving the chat or unmounting stops what is still uploading.
  useEffect(() => {
    const active = running.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
      stored.current.clear();
      setBusyRef.current?.(BUSY_ID, false);
    };
  }, [chatId]);

  // The user removed a file from the composer: stop its upload, free its storage.
  const handleFileSelect = useCallback(
    next => {
      const kept = new Set([next].flat().filter(Boolean).map(entryKey));
      for (const entry of [selectionRef.current].flat().filter(Boolean)) {
        const key = entryKey(entry);
        if (kept.has(key)) continue;
        running.current.get(key)?.abort();
        running.current.delete(key);
        stored.current.delete(key);
        if (entry.serverStored && entry.fileId && chatIdRef.current) {
          deleteChatFile(chatIdRef.current, entry.fileId).catch(() => {});
        }
      }
      reportBusy();
      setSelectedFile(next);
    },
    [reportBusy, setSelectedFile]
  );

  return { handleFileSelect, enabled, mode };
}
