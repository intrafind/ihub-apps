// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchIntegrationFilesProbe } from '../../../api/endpoints/integrationFiles';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { processCloudFile } from '../../upload/utils/cloudFileProcessing';
import {
  appBindsIntegration,
  documentFailureKind,
  documentKindOf,
  documentRefOf
} from '../utils/pendingDocument';
import { fetchIntegrationDocumentFile } from '../utils/integrationDocument';

/**
 * Whether the selected model can take a file of this kind. The app's binding of the integration is
 * what lets it receive the document (its local upload settings do not veto it, as they do not veto
 * a storage provider's files); what only the model can decide is left: an image needs a model that
 * sees, audio one that hears. A document is text that any model reads.
 *
 * @param {'image'|'audio'|'document'} kind
 * @param {Object|null} model - the selected model object
 * @returns {boolean}
 */
function modelTakes(kind, model) {
  if (kind === 'image') return model?.supportsVision !== false && model?.supportsImages !== false;
  if (kind === 'audio') return model?.supportsAudio === true;
  return true;
}

/**
 * Attaches the document a link names (`?documentId=…&integration=…`) to the chat, once the app and
 * its model are known — the way the Nextcloud embed attaches the files a user picked there
 * (`useNextcloudEmbedAttachments`):
 *
 * 1. ask the integration whether it hands documents to this user (the gate);
 * 2. fetch the **original** file through `GET /api/integrations/:id/files/content`, with the
 *    user's own permissions in that system;
 * 3. check that the app binds the integration (its local upload settings do not matter) and that
 *    the selected model can take what the file is (an image needs a model that sees);
 * 4. `processCloudFile`: an image becomes an image attachment for a vision model, audio an audio
 *    attachment, anything else a document that keeps its original next to the extracted text.
 *
 * A placeholder shows while it loads. A document that cannot be attached says why in the chat
 * (`addSystemMessage`): no access, not found, the integration not available, the app does not use it, or
 * the model cannot take this kind of file. Whatever happens, `onConsumed` runs at the end so the link's parameters
 * leave the address and a refresh does not attach again.
 *
 * @param {Object} options
 * @param {{documentId: string, integration: string, searchProfile?: string, prefill?: string}|null} options.pending
 * @param {boolean} options.ready - the app and the models are loaded
 * @param {Object} options.app
 * @param {Object|null} options.currentModel - the selected model object
 * @param {Object} options.fileUploadHandler - `useFileUploadHandler()`
 * @param {(content: string, isError?: boolean) => void} options.addSystemMessage
 * @param {() => void} options.onConsumed
 */
export default function useIntegrationDocumentAttachment({
  pending,
  ready,
  app,
  currentModel,
  fileUploadHandler,
  addSystemMessage,
  onConsumed
}) {
  const { t, i18n } = useTranslation();
  const liveRef = useRef({});
  // Read through a ref so a re-render (a new handler object, a model that finished loading) neither
  // restarts nor cancels a download that is under way.
  useEffect(() => {
    liveRef.current = {
      pending,
      app,
      currentModel,
      fileUploadHandler,
      addSystemMessage,
      onConsumed,
      t,
      language: i18n.language
    };
  });

  const key = pending
    ? `${pending.integration}\u0000${pending.documentId}\u0000${pending.searchProfile || ''}`
    : null;
  const attachedKey = useRef(null);

  useEffect(() => {
    if (!key || !ready || attachedKey.current === key) return;
    attachedKey.current = key;

    const run = async () => {
      const live = liveRef.current;
      const { pending: doc, fileUploadHandler: uploader } = live;
      const say = message => live.addSystemMessage?.(message, true);
      const ref = documentRefOf(doc);
      const fallbackName = doc.prefill || 'document';

      try {
        const uploadConfig = uploader.createUploadConfig(live.app, live.currentModel) || {};

        uploader.setSelectedFile({
          type: 'document',
          source: doc.integration,
          fileName: doc.prefill || live.t('attachedFiles.loading', 'Loading document...'),
          fileSize: 0,
          fileType: 'application/octet-stream',
          loading: true
        });

        // The probe is the gate: not installed, not configured or not granted ends here.
        const info = await fetchIntegrationFilesProbe({ integration: doc.integration });
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
        const file = await fetchIntegrationDocumentFile({
          integration: doc.integration,
          ref,
          fallbackName
        });

        const kind = documentKindOf({ contentType: file.type, filename: file.name });
        if (!modelTakes(kind, live.currentModel)) {
          uploader.clearSelectedFile();
          say(
            live.t(
              'sources.documentModelCannot',
              'The document could not be attached: the selected model cannot take this kind of file.'
            )
          );
          return;
        }

        const processed = await processCloudFile(file, uploadConfig);
        const label = getLocalizedContent(info?.name, live.language);
        uploader.setSelectedFile({
          ...processed,
          source: doc.integration,
          integration: doc.integration,
          ...(kind === 'document' && label
            ? {
                displayType: live.t('sources.documentFromIntegration', {
                  defaultValue: '{{name}} document',
                  name: label
                })
              }
            : {})
        });
      } catch (err) {
        console.error('Failed to fetch and attach the document:', err);
        uploader.clearSelectedFile();
        const failure =
          err?.response?.data?.code === 'INTEGRATION_NOT_GRANTED' ||
          err?.response?.data?.code === 'INTEGRATION_NOT_CONFIGURED' ||
          err?.response?.data?.code === 'INTEGRATION_NOT_FOUND'
            ? 'unavailable'
            : documentFailureKind(err?.response?.status);
        say(
          {
            unavailable: live.t(
              'sources.documentUnavailable',
              'The document could not be attached: the system it comes from is not available to you.'
            ),
            noAccess: live.t(
              'sources.documentNoAccess',
              'The document could not be attached: you do not have access to it.'
            ),
            notFound: live.t(
              'sources.documentNotFound',
              'The document could not be attached: it was not found. It may have been moved or deleted.'
            ),
            failed: live.t(
              'sources.documentAttachFailed',
              'The document could not be attached. Please try again.'
            )
          }[failure]
        );
      } finally {
        live.onConsumed?.();
      }
    };

    void run();
  }, [key, ready]);
}
