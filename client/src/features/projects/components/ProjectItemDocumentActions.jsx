// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { lazy, Suspense, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '../../../utils/externalNavigation';

// Loaded on demand, as in the sources panel: the preview pulls in pdf.js, and
// none of the dialogs is needed before a document action is picked.
const DocumentPreviewModal = lazy(
  () => import('../../documentPreview/components/DocumentPreviewModal')
);
const SourceDetailsModal = lazy(() => import('../../chat/components/SourceDetailsModal'));

/**
 * A project item as a source (`shared/sources/source.js`) of the `project`
 * provider, which reads it with the viewer's own rights — for an iFinder
 * document, through iFinder with the viewer's token, exactly as a citation of
 * it in a chat.
 *
 * @param {string} projectId
 * @param {Object} item
 * @returns {Object}
 */
export function itemSource(projectId, item) {
  return {
    id: `project:${projectId}:${item.id}`,
    provider: 'project',
    kind: 'document',
    ref: { id: item.id, scope: projectId },
    title: item.name,
    provenance: item.provenance || null
  };
}

/**
 * The document actions of a project's items, the same the sources panel of a
 * chat offers for an iFinder document: a preview of the original, a download,
 * its details and opening it where it lives (iFinder's deep link). Returns the
 * handler the items table calls and the dialogs to render.
 *
 * @param {string} projectId
 * @returns {{onDocumentAction: (action: 'previewDocument'|'download'|'details'|'open', item: Object) => Promise<void>,
 *   dialogs: JSX.Element, error: string|null, clearError: () => void, busyId: string|null}}
 */
export function useProjectItemDocumentActions(projectId) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const onDocumentAction = useCallback(
    async (action, item) => {
      setError(null);
      const source = itemSource(projectId, item);
      if (action === 'previewDocument' || action === 'details') {
        setDialog({ type: action, source });
        return;
      }
      setBusyId(item.id);
      try {
        if (action === 'download') {
          const { downloadSource } = await import('../../chat/sources/sourceActions');
          const result = await downloadSource(source);
          if (!result.ok) {
            setError(
              t('sources.downloadFailed', 'The document could not be downloaded. Please try again.')
            );
          }
          return;
        }
        if (action === 'open') {
          // The deep link comes with the details, read with the viewer's rights.
          let link = null;
          try {
            const { fetchSourceMetadata } = await import('../../../api/endpoints/sources');
            const details = await fetchSourceMetadata({ source });
            link = details?.deepLink || details?.url || null;
          } catch {
            link = null;
          }
          if (!link || !/^https?:\/\//i.test(link)) {
            setError(
              t('projects.items.openUnavailable', 'This document has no link to open it with.')
            );
            return;
          }
          // A browser that refuses the new tab (it opens after a request, not
          // straight from the click) still gets the link: the details show it.
          if (!openExternalUrl(link)) setDialog({ type: 'details', source });
        }
      } finally {
        setBusyId(null);
      }
    },
    [projectId, t]
  );

  const close = useCallback(() => setDialog(null), []);
  const dialogs = (
    <>
      {dialog?.type === 'previewDocument' && (
        <Suspense fallback={null}>
          <DocumentPreviewModal
            source={dialog.source}
            title={dialog.source.title}
            onClose={close}
          />
        </Suspense>
      )}
      {dialog?.type === 'details' && (
        <Suspense fallback={null}>
          <SourceDetailsModal source={dialog.source} onClose={close} />
        </Suspense>
      )}
    </>
  );

  return { onDocumentAction, dialogs, error, clearError: () => setError(null), busyId };
}
