// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchIntegrationFilesProbe } from '../../../api/endpoints/integrationFiles';
import { deleteChatFile, uploadChatFile } from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { processCloudFile } from '../../upload/utils/cloudFileProcessing';
import {
  appBindsIntegration,
  boundToolRefsFor,
  documentFailureKind,
  documentKindOf,
  documentRefOf,
  serverFileSourceFor
} from '../utils/pendingDocument';
import { fetchIntegrationDocumentFile } from '../utils/integrationDocument';
import { modelTakesFileKind } from '../../../shared/utils/modelInputCapabilities';
import { uploadErrorCode, withStoredFile } from '../../chat/utils/chatFileUpload';

/** The id under which this hook reports itself as busy to the composer (`setAttachmentProcessing`). */
const BUSY_ID = 'integration-document';

/** What identifies a pending document: the system it comes from, its id and its scope. */
const documentKey = pending =>
  pending
    ? `${pending.integration}\u0000${pending.documentId}\u0000${pending.searchProfile || ''}`
    : null;

/** The label under which an integration's document is shown (`iFinder document`), or `{}`. */
function displayTypeOf(live, info) {
  const label = getLocalizedContent(info?.name, live.language);
  return label
    ? {
        displayType: live.t('sources.documentFromIntegration', {
          defaultValue: '{{name}} document',
          name: label
        })
      }
    : {};
}

/**
 * The user-facing kind of a failed attach: the integration is not available (the gate, or the
 * server's refusal to fetch from it), no access, not found, or a failure to try again.
 *
 * The file API wraps the axios error (`originalError`); the integration routes do not.
 *
 * @param {Object} err
 * @returns {'unavailable'|'noAccess'|'notFound'|'failed'}
 */
function failureKindOf(err) {
  const response = err?.response || err?.originalError?.response;
  const code = response?.data?.code || response?.data?.details?.code;
  if (UNAVAILABLE_CODES.has(code)) return 'unavailable';
  return documentFailureKind(response?.status);
}

/** The chat message for a failed attach. */
function failureMessageOf(kind, t) {
  return {
    unavailable: t(
      'sources.documentUnavailable',
      'The document could not be attached: the system it comes from is not available to you.'
    ),
    noAccess: t(
      'sources.documentNoAccess',
      'The document could not be attached: you do not have access to it.'
    ),
    notFound: t(
      'sources.documentNotFound',
      'The document could not be attached: it was not found. It may have been moved or deleted.'
    ),
    failed: t(
      'sources.documentAttachFailed',
      'The document could not be attached. Please try again.'
    )
  }[kind];
}

/** Codes of a refusal that means the system the document comes from is not available. */
const UNAVAILABLE_CODES = new Set([
  'INTEGRATION_NOT_GRANTED',
  'INTEGRATION_NOT_CONFIGURED',
  'INTEGRATION_NOT_FOUND',
  'SOURCE_UNAVAILABLE'
]);

/**
 * Attach by reference: the server fetches the document, stores it and reads it; nothing passes
 * through the browser. The composer gets a stub (see `attachmentContent.js`).
 *
 * @param {Object} ctx - `{ live, doc, uploader, stale, dropPlaceholder, fallbackName }` of the run
 * @param {Object} info - the probe's answer
 * @param {{kind: string, ref: Object}} source - what the server fetches
 * @param {{ephemeral?: boolean}} serverFiles
 * @returns {Promise<'attached'|'stale'|'fallback'>} `fallback`: the server cannot take the file as a
 *   document (an image, audio), so the browser fetches it; any other refusal is thrown
 */
async function attachByReference(ctx, info, source, serverFiles) {
  const { live, doc, uploader, stale, dropPlaceholder, fallbackName } = ctx;
  let stored;
  try {
    stored = await uploadChatFile(
      live.chatId,
      { source },
      {
        fields: {
          ...(live.app?.id ? { appId: live.app.id } : {}),
          ...(serverFiles.ephemeral ? { ephemeral: true } : {})
        }
      }
    );
  } catch (serverError) {
    // Only "not a document" falls back; everything else is reported by the caller.
    if (uploadErrorCode(serverError) === 'UNSUPPORTED_TYPE') return 'fallback';
    throw serverError;
  }
  const descriptor = stored?.file;
  if (!descriptor?.id) throw new Error('No file in the response');
  if (stale()) {
    // The chat moved on: do not leave the file the server just stored behind
    deleteChatFile(live.chatId, descriptor.id).catch(() => {});
    dropPlaceholder();
    return 'stale';
  }
  uploader.setSelectedFile(
    withStoredFile(
      {
        type: 'document',
        source: doc.integration,
        integration: doc.integration,
        chatId: live.chatId,
        fileName: descriptor.name || fallbackName,
        fileSize: descriptor.originalBytes || descriptor.bytes || 0,
        fileType: descriptor.mimeType || 'application/octet-stream',
        ...displayTypeOf(live, info)
      },
      descriptor
    )
  );
  return 'attached';
}

/**
 * Attach in the browser: fetch the original through the integration's route, check that the model
 * can take it, and process it like the Nextcloud embed does (an image for a vision model, audio, or
 * a document that keeps its original next to the extracted text).
 *
 * @param {Object} ctx - see {@link attachByReference}
 * @param {Object} info - the probe's answer
 * @param {Object} uploadConfig
 * @returns {Promise<void>}
 */
async function attachInBrowser(ctx, info, uploadConfig) {
  const { live, doc, uploader, stale, dropPlaceholder, fallbackName } = ctx;
  const file = await fetchIntegrationDocumentFile({
    integration: doc.integration,
    ref: documentRefOf(doc),
    fallbackName
  });
  if (stale()) return dropPlaceholder();

  const kind = documentKindOf({ contentType: file.type, filename: file.name });
  if (!modelTakesFileKind(kind, live.currentModel)) {
    uploader.clearSelectedFile();
    live.addSystemMessage?.(
      live.t(
        'sources.documentModelCannot',
        'The document could not be attached: the selected model cannot take this kind of file.'
      ),
      true
    );
    return undefined;
  }

  const processed = await processCloudFile(file, uploadConfig);
  if (stale()) return dropPlaceholder();
  uploader.setSelectedFile({
    ...processed,
    source: doc.integration,
    integration: doc.integration,
    ...(kind === 'document' ? displayTypeOf(live, info) : {})
  });
  return undefined;
}

/**
 * Attaches the document a link names (`?documentId=…&integration=…`) to the chat, once the app and
 * its model are known:
 *
 * 1. ask the integration whether it hands documents to this user (the gate), and check that the
 *    app binds it (its local upload settings do not matter);
 * 2. **by reference, on the server** — when the chat keeps files on the server and the server can
 *    fetch from the integration (iFinder): post `{ source: { kind, ref } }` to the chat's file
 *    endpoint. The server fetches the original itself with the user's own rights, stores it and
 *    extracts the text; the composer holds a stub (the stored file's id), and the document never
 *    passes through the browser;
 * 3. **in the browser** — otherwise (the server keeps no chat files, the integration is not one the
 *    server can fetch from, or the file is an image or audio that has to reach a vision or audio
 *    model as bytes): fetch the original through `GET /api/integrations/:integration/files/:id/content`,
 *    check that the model can take it, and `processCloudFile` it the way the Nextcloud embed does
 *    (`useNextcloudEmbedAttachments`).
 *
 * A placeholder shows while it loads. A document that cannot be attached says why in the chat
 * (`addSystemMessage`): no access, not found, the integration not available, the app does not use it, or
 * the model cannot take this kind of file. Whatever happens, `onConsumed` runs at the end so the link's parameters
 * leave the address and a refresh does not attach again.
 *
 * @param {Object} options
 * @param {{documentId: string, integration: string, searchProfile?: string, prefill?: string}|null} options.pending
 * @param {boolean} options.ready - this chat's app is loaded and its settings picked a model
 * @param {string} [options.appId] - the route's app: a change ends a run that is under way
 * @param {string} [options.chatId] - the chat shown: a new chat ends a run that is under way
 * @param {Object} options.app
 * @param {Object|null} options.currentModel - the selected model object
 * @param {Object} options.fileUploadHandler - `useFileUploadHandler()`
 * @param {(content: string, isError?: boolean) => void} options.addSystemMessage
 * @param {{enabled: boolean, ephemeral?: boolean}} [options.serverFiles] - whether the chat keeps
 *   files on the server (`useChatFilePreUpload().enabled`) and whether the chat is temporary
 * @param {(refs: string[]) => void} [options.onIntegrationBound] - the tool references of the app's
 *   binding for the integration the document comes from: the chat switches them on, whatever the
 *   user's default for the app says, because the link came from that system
 * @param {() => void} options.onConsumed
 */
export default function useIntegrationDocumentAttachment({
  pending,
  ready,
  appId,
  chatId,
  app,
  currentModel,
  fileUploadHandler,
  addSystemMessage,
  serverFiles,
  onIntegrationBound,
  onConsumed
}) {
  const { t, i18n } = useTranslation();
  const liveRef = useRef({});
  // Read through a ref so a re-render (a new handler object, a model that finished loading) neither
  // restarts nor cancels a download that is under way.
  useEffect(() => {
    liveRef.current = {
      pending,
      appId,
      chatId,
      app,
      currentModel,
      fileUploadHandler,
      addSystemMessage,
      serverFiles,
      onIntegrationBound,
      onConsumed,
      t,
      language: i18n.language
    };
  });

  const key = documentKey(pending);
  const attachedKeyRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!key || !ready || attachedKeyRef.current === key) return;
    attachedKeyRef.current = key;

    const run = async () => {
      const live = liveRef.current;
      const { pending: doc, fileUploadHandler: uploader, serverFiles } = live;
      const startedAppId = live.app?.id;
      const startedRouteAppId = live.appId;
      const startedChatId = live.chatId;
      // What this run started for is gone: the chat was left, a new chat started, another app
      // opened, or another document is pending. It then touches neither the attachment nor the
      // address.
      const stale = () => {
        const now = liveRef.current;
        return (
          !mountedRef.current ||
          documentKey(now.pending) !== key ||
          now.app?.id !== startedAppId ||
          now.appId !== startedRouteAppId ||
          now.chatId !== startedChatId
        );
      };
      const say = message => live.addSystemMessage?.(message, true);
      // The loading placeholder this run put into the composer. A stale run takes it away so it does
      // not stay as an endless spinner, but only while it is still what the composer shows: a file
      // the user (or a newer run) selected meanwhile is not this run's to remove.
      let placeholder = null;
      const dropPlaceholder = () => {
        const handler = liveRef.current.fileUploadHandler;
        if (placeholder && handler?.selectedFile === placeholder) handler.clearSelectedFile();
      };
      const fallbackName = doc.prefill || 'document';

      try {
        // A message sent while the document loads would go out without it (the composer holds
        // Send while an attachment is processing), whether the user presses it or the link
        // auto-sends.
        uploader.setAttachmentProcessing?.(BUSY_ID, true);
        const uploadConfig = uploader.createUploadConfig(live.app, live.currentModel) || {};

        placeholder = {
          type: 'document',
          source: doc.integration,
          fileName: doc.prefill || live.t('attachedFiles.loading', 'Loading document...'),
          fileSize: 0,
          fileType: 'application/octet-stream',
          loading: true
        };
        uploader.setSelectedFile(placeholder);

        // The probe is the gate: not installed, not configured or not granted ends here.
        const info = await fetchIntegrationFilesProbe({ integration: doc.integration });
        if (stale()) {
          dropPlaceholder();
          return;
        }
        // An installed integration's documents go only to an app that binds it: the binding is
        // what lets the app receive them (as with a storage provider's files), whatever its local
        // upload settings say. A provider that is not an installation (`project`) keeps its own rules.
        if (info?.definition && !appBindsIntegration(live.app, info)) {
          uploader.clearSelectedFile();
          say(
            live.t(
              'sources.documentAppNotBound',
              'The document could not be attached: this app does not use the system it comes from.'
            )
          );
          return;
        }
        // The link came from that system, so its tools are on in this chat even when the user's
        // default for the app has them off (or the binding is available only).
        const boundRefs = boundToolRefsFor(live.app, info);
        if (boundRefs.length > 0) liveRef.current.onIntegrationBound?.(boundRefs);
        // By reference where the server can fetch from the integration; a file it cannot take as a
        // document (an image, audio) goes the browser's way, where the model gets its bytes.
        const ctx = { live, doc, uploader, stale, dropPlaceholder, fallbackName };
        const serverSource =
          serverFiles?.enabled && live.chatId ? serverFileSourceFor(info, doc) : null;
        if (serverSource) {
          const outcome = await attachByReference(ctx, info, serverSource, serverFiles);
          if (outcome !== 'fallback') return;
        }
        await attachInBrowser(ctx, info, uploadConfig);
      } catch (err) {
        console.error('Failed to fetch and attach the document:', err);
        if (stale()) {
          dropPlaceholder();
          return;
        }
        uploader.clearSelectedFile();
        say(failureMessageOf(failureKindOf(err), live.t));
      } finally {
        // Also when the run is stale: the flag is this run's, and nothing else clears it.
        uploader.setAttachmentProcessing?.(BUSY_ID, false);
        // The latest callback: it reads the address as it is now, not as it was when this run
        // started, so it cannot bring back a setting the user removed meanwhile. Not at all when
        // the run is stale: the address belongs to something else by then.
        if (!stale()) liveRef.current.onConsumed?.();
      }
    };

    void run();
  }, [key, ready]);
}
