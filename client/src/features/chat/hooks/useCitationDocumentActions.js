import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchIFinderDocument } from '../../../api/endpoints/ifinder';
import { useEmbeddedHostAdapter } from '../../office/contexts/EmbeddedHostContext';
import { openExternalUrl } from '../../../utils/externalNavigation';
import { blobToBase64, downloadBlob, resolveDownloadFilename } from '../../../utils/fileDownload';

/**
 * The document actions on a citation — open the source, download the file, and
 * attach it to the mail being written — for every host the chat UI renders in.
 *
 * Each host needs something different, and the differences are exactly where
 * the actions used to break (issue #2453):
 *
 *   - **Opening a link.** `window.open()` is blocked in the Outlook task pane
 *     and the extension side panel. Those hosts hand in their own opener via
 *     the embedded-host adapter; the web app keeps `window.open`. Either way a
 *     blocked link now reports itself instead of doing nothing.
 *   - **Downloading.** Navigating to the proxy URL only authenticates in the
 *     web app, where the session cookie rides along. The document is fetched
 *     on the authenticated API path and saved through an `<a download>`, which
 *     works in all four hosts.
 *   - **Attaching.** Outlook takes the downloaded bytes as base64 and puts
 *     them on the draft. No other host offers the action.
 *
 * Every action reports progress and failure per document, which the caller
 * renders next to the document it belongs to.
 *
 * @returns {Object} actions, the current per-document status, and what the
 *   host supports.
 */
export default function useCitationDocumentActions() {
  const { t } = useTranslation();
  const host = useEmbeddedHostAdapter();
  // docId -> { busy: 'download'|'attach', error: string, notice: string }
  const [status, setStatus] = useState({});
  // Documents with a request in flight. Without this a second click while the
  // download is running would attach the same file to the mail twice.
  const inFlightRef = useRef(new Set());

  const fileAttachment = host?.fileAttachment;

  const evaluateCanAttach = useCallback(() => {
    if (typeof fileAttachment?.attach !== 'function') return false;
    try {
      return fileAttachment.isAvailable ? fileAttachment.isAvailable() !== false : true;
    } catch {
      return false;
    }
  }, [fileAttachment]);

  // Whether the host can take an attachment depends on what is open in it: in
  // Outlook, a draft accepts one and a received mail does not. The task pane
  // announces every switch as `ihub:itemchanged`, so the answer is re-read
  // there rather than cached for the lifetime of the message.
  const [canAttach, setCanAttach] = useState(evaluateCanAttach);

  useEffect(() => {
    if (!fileAttachment) return undefined;
    const handler = () => setCanAttach(evaluateCanAttach());
    document.addEventListener('ihub:itemchanged', handler);
    return () => document.removeEventListener('ihub:itemchanged', handler);
  }, [evaluateCanAttach, fileAttachment]);

  const setDocStatus = useCallback((docId, next) => {
    setStatus(prev => {
      if (!next) {
        if (!prev[docId]) return prev;
        const { [docId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [docId]: next };
    });
  }, []);

  const clearStatus = useCallback(docId => setDocStatus(docId, null), [setDocStatus]);

  /** Turn an API failure into something a user can act on. */
  const describeFetchError = useCallback(
    error => {
      const httpStatus = error?.response?.status || error?.status;
      if (httpStatus === 401 || httpStatus === 403) {
        return t('citations.errors.accessDenied', 'You do not have access to this document.');
      }
      if (httpStatus === 404) {
        return t('citations.errors.notFound', 'This document is no longer available.');
      }
      return (
        error?.message ||
        t('citations.errors.unknown', 'Something went wrong while fetching the document.')
      );
    },
    [t]
  );

  /**
   * Download a citation's document on the authenticated API path.
   *
   * @param {{documentId: string, searchProfile?: string, title?: string, fileName?: string}} doc
   * @returns {Promise<{blob: Blob, filename: string}>}
   */
  const fetchDocumentFile = useCallback(async doc => {
    const { data, contentType, filename } = await fetchIFinderDocument({
      documentId: doc.documentId,
      searchProfile: doc.searchProfile
    });
    return {
      blob: data,
      filename: resolveDownloadFilename({
        headerFilename: filename,
        fileName: doc.fileName,
        title: doc.title,
        contentType
      })
    };
  }, []);

  /**
   * Open the document at its source (the iFinder deep link).
   *
   * @param {string} docId
   * @param {string} url
   */
  const openExternal = useCallback(
    async (docId, url) => {
      if (!url) return;
      clearStatus(docId);
      const opened = await openExternalUrl(url, host);
      if (!opened) {
        setDocStatus(docId, {
          error: t(
            'citations.errors.openBlocked',
            'This window cannot open links. Use the link under Details, or open the document in your browser.'
          )
        });
      }
    },
    [clearStatus, host, setDocStatus, t]
  );

  /**
   * Save the document to disk.
   *
   * @param {string} docId
   * @param {Object} doc see `fetchDocumentFile`.
   */
  const download = useCallback(
    async (docId, doc) => {
      if (!doc?.documentId || inFlightRef.current.has(docId)) return;
      inFlightRef.current.add(docId);
      setDocStatus(docId, { busy: 'download' });
      try {
        const { blob, filename } = await fetchDocumentFile(doc);
        downloadBlob(blob, filename);
        setDocStatus(docId, null);
      } catch (error) {
        console.error('[iHub] citation download failed:', error);
        setDocStatus(docId, {
          error: t(
            'citations.errors.downloadFailed',
            'Could not download this document. {{reason}}',
            {
              reason: describeFetchError(error)
            }
          )
        });
      } finally {
        inFlightRef.current.delete(docId);
      }
    },
    [describeFetchError, fetchDocumentFile, setDocStatus, t]
  );

  /**
   * Attach the document to the mail the user is writing.
   *
   * @param {string} docId
   * @param {Object} doc see `fetchDocumentFile`.
   */
  const attachToItem = useCallback(
    async (docId, doc) => {
      if (!doc?.documentId || typeof fileAttachment?.attach !== 'function') return;
      if (inFlightRef.current.has(docId)) return;

      inFlightRef.current.add(docId);
      setDocStatus(docId, { busy: 'attach' });
      try {
        const { blob, filename } = await fetchDocumentFile(doc);

        const maxBytes = fileAttachment.maxBytes;
        if (maxBytes && blob.size > maxBytes) {
          setDocStatus(docId, {
            error: t(
              'citations.errors.attachTooLarge',
              'This document is too large to attach ({{size}} MB). Download it instead.',
              { size: Math.round((blob.size / (1024 * 1024)) * 10) / 10 }
            )
          });
          return;
        }

        await fileAttachment.attach({ base64: await blobToBase64(blob), filename });
        setDocStatus(docId, {
          notice: t('citations.attachedToEmail', 'Added to your email as {{filename}}.', {
            filename
          })
        });
      } catch (error) {
        console.error('[iHub] citation attach failed:', error);
        const message =
          error?.message === 'NOT_COMPOSING'
            ? t(
                fileAttachment.unavailableHintKey || 'citations.errors.attachNeedsDraft',
                'Open a new email or a reply first, then add the document from there.'
              )
            : t('citations.errors.attachFailed', 'Could not attach this document. {{reason}}', {
                reason: describeFetchError(error)
              });
        setDocStatus(docId, { error: message });
      } finally {
        inFlightRef.current.delete(docId);
      }
    },
    [describeFetchError, fetchDocumentFile, fileAttachment, setDocStatus, t]
  );

  return {
    status,
    openExternal,
    download,
    attachToItem,
    /** The host offers attaching at all (Outlook). */
    attachSupported: typeof fileAttachment?.attach === 'function',
    /** The host can take an attachment right now (a draft is open). */
    canAttach,
    attachLabelKey: fileAttachment?.labelKey || 'citations.attachToEmail',
    attachUnavailableHintKey:
      fileAttachment?.unavailableHintKey || 'citations.errors.attachNeedsDraft'
  };
}
