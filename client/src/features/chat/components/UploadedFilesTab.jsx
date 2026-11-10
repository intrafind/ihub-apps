// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { renderMarkdown } from '../../../config/marked.config';
import { saveBlobAs } from '../../../utils/externalNavigation';
import { isOriginalDiscarded } from '../../../api/utils/fileErrors';
import { DANGER_BUTTON, GHOST_BUTTON, SECONDARY_BUTTON } from '../../../shared/utils/buttonTokens';
import PaneHeader from '../../workspace/components/PaneHeader';
import SelectionScope from '../../workspace/components/SelectionScope';
import ArtifactPreview from './ArtifactPreview';
import { saveName } from '../utils/artifactFiles';
import {
  extractedTextFileName,
  parseStructuredText,
  uploadedFileBadge,
  uploadedStorageState,
  uploadedViewKind
} from '../utils/uploadedFiles';

/** The header table and body of an e-mail, meeting or web page. */
function StructuredItem({ text, kind }) {
  const { t } = useTranslation();
  const { headers, body } = useMemo(() => parseStructuredText(text), [text]);
  return (
    <div data-testid={`uploaded-${kind}-viewer`}>
      {headers.length > 0 && (
        <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 text-sm">
          {headers.map((header, index) => (
            <div key={`${header.name}-${index}`} className="contents">
              <dt className="font-medium text-gray-600 dark:text-gray-300">{header.name}</dt>
              <dd className="min-w-0 break-words text-gray-900 dark:text-gray-100">
                {header.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {kind === 'page' ? (
        <article
          className="prose prose-sm dark:prose-invert max-w-none"
          // Sanitized by renderMarkdown (DOMPurify).
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
        />
      ) : (
        <pre className="whitespace-pre-wrap break-words rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 text-sm text-gray-900 dark:text-gray-100">
          {body || t('chatFiles.emptyBody', '(no text)')}
        </pre>
      )}
    </div>
  );
}

/**
 * The preview of one uploaded file: the structured viewers for e-mails,
 * meetings and pages, the original for what a browser can show (PDF, picture,
 * CSV, notebook, code), the extracted text for the rest.
 */
function UploadedPreview({ file, source, getBlob }) {
  const { t } = useTranslation();
  const kind = uploadedViewKind(file);
  const [text, setText] = useState({ status: 'idle' });
  const needsText = !['pdf', 'image', 'csv', 'ipynb', 'code'].includes(kind);

  useEffect(() => {
    if (!needsText) return undefined;
    let active = true;
    setText({ status: 'loading' });
    source
      .fetchText(file.id)
      .then(result => {
        if (active) setText({ status: 'ready', text: result?.text || '' });
      })
      .catch(() => {
        if (active) setText({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [file.id, needsText, source]);

  // A synthetic artifact for the generic previewer when the text is what is shown.
  const textArtifact = useMemo(
    () => ({ id: `${file.id}:text`, name: extractedTextFileName(file), mimeType: 'text/markdown' }),
    [file]
  );
  const getTextBlob = useCallback(() => Promise.resolve(new Blob([text.text || ''])), [text.text]);

  if (needsText && text.status === 'loading') {
    return (
      <output className="block text-sm text-gray-500 dark:text-gray-400">
        {t('chatArtifacts.previewLoading', 'Loading preview…')}
      </output>
    );
  }
  if (needsText && text.status === 'error') {
    return (
      <p className="text-sm text-red-700 dark:text-red-400" role="alert">
        {t('chatArtifacts.previewFailed', 'The preview could not be loaded.')}
      </p>
    );
  }
  if (kind === 'email' || kind === 'meeting' || kind === 'page') {
    return <StructuredItem text={text.text} kind={kind} />;
  }
  if (!needsText) {
    return (
      <ArtifactPreview
        key={file.id}
        artifact={{ id: file.id, name: file.name, mimeType: file.mimeType }}
        getBlob={getBlob}
      />
    );
  }
  return (
    <>
      <p className="mb-2 text-xs text-gray-600 dark:text-gray-300">
        {t('chatFiles.textPreviewNote', 'Showing the text the assistant reads from this file.')}
      </p>
      <ArtifactPreview key={`${file.id}:text`} artifact={textArtifact} getBlob={getTextBlob} />
    </>
  );
}

/**
 * One uploaded file in the workspace pane: the shared header and its preview.
 * Uploads are immutable inputs, so the actions are reading ones — download the
 * original (the original may be gone: only its text is kept then) or the text —
 * plus Delete and, in the Outlook task pane while a mail is being written,
 * "Attach to email". Attach sits in ⋯ and is a visible header button on the
 * Outlook surface; Delete sits in ⋯ and asks once more in the body.
 *
 * @param {Object} props
 * @param {Object|null} props.file - The descriptor, or null: the file is gone.
 * @param {'loading'|'ready'|'error'|'idle'} props.status - Of the list the file comes from.
 * @param {Object} props.source
 * @param {(id: string) => Promise<{ text: string }>} props.source.fetchText
 * @param {(id: string) => Promise<Blob>} props.source.fetchBlob
 * @param {(id: string) => Promise<unknown>} [props.source.remove] - Absent: read-only (a shared chat).
 * @param {() => void} [props.onDeleted] - After the file was deleted.
 * @param {{ available: boolean, attach: (params: Object) => Promise<Object> }|null} [props.mailAttach]
 * @param {boolean} [props.attachProminent] - Outlook: "Attach to email" as a visible button.
 * @param {'none'|'extracted_text'|'original'|null} [props.access] - On a shared chat: what the owner shared.
 * @param {Object} props.chrome - What the pane gives every detail view.
 */
export default function UploadedFileDetail({
  file,
  status,
  source,
  onDeleted,
  mailAttach = null,
  attachProminent = false,
  access = null,
  chrome
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const blobsRef = useRef(new Map());

  useEffect(() => {
    blobsRef.current = new Map();
  }, [source]);
  useEffect(() => {
    setConfirmDelete(false);
    setNotice(null);
  }, [file?.id]);

  const getBlob = useCallback(
    id => {
      if (!blobsRef.current.has(id)) {
        const pending = source.fetchBlob(id);
        pending.catch(() => blobsRef.current.delete(id));
        blobsRef.current.set(id, pending);
      }
      return blobsRef.current.get(id);
    },
    [source]
  );

  const say = (tone, text) => {
    setNotice({ tone, text });
    chrome?.announce?.(text);
  };

  const run = async (name, task) => {
    setBusy(name);
    setNotice(null);
    try {
      await task();
    } finally {
      setBusy(null);
    }
  };

  const discardedText = t(
    'chatFiles.originalDiscarded',
    'The original file is no longer stored; only its text is kept. You can download the text instead.'
  );

  const downloadOriginal = () =>
    run('original', async () => {
      try {
        const blob = await getBlob(file.id);
        if (!saveBlobAs(blob, saveName(file.name))) throw new Error('save');
      } catch (error) {
        say(
          'error',
          isOriginalDiscarded(error)
            ? discardedText
            : t('chatArtifacts.downloadFailed', 'The download failed. Please try again.')
        );
      }
    });

  const downloadText = () =>
    run('text', async () => {
      try {
        const result = await source.fetchText(file.id);
        const blob = new Blob([result?.text || ''], { type: 'text/plain;charset=utf-8' });
        if (!saveBlobAs(blob, extractedTextFileName(file))) throw new Error('save');
      } catch {
        say('error', t('chatArtifacts.downloadFailed', 'The download failed. Please try again.'));
      }
    });

  const copyText = () =>
    run('copy', async () => {
      try {
        const result = await source.fetchText(file.id);
        await navigator.clipboard.writeText(result?.text || '');
        say('info', t('chatArtifacts.copied', 'Copied to the clipboard.'));
      } catch {
        say('error', t('chatArtifacts.copyFailed', 'The content could not be copied.'));
      }
    });

  const deleteFile = () =>
    run('delete', async () => {
      try {
        await source.remove(file.id);
        setConfirmDelete(false);
        chrome?.announce?.(t('chatFiles.deleted', '{{name}} deleted.', { name: file.name }));
        onDeleted?.();
      } catch {
        say(
          'error',
          t('chatFiles.deleteFailed', 'The file could not be deleted. Please try again.')
        );
      }
    });

  const attachToMail = () =>
    run('attach', async () => {
      const result = await mailAttach.attach({ file, fetchBlob: () => getBlob(file.id) });
      if (result.ok) {
        say(
          'info',
          t('chatFiles.attached', 'Attached {{name}} to your email.', { name: result.filename })
        );
      } else {
        say(
          'error',
          result.reason === 'tooLarge'
            ? t('chatFiles.attachTooLarge', 'The file is too large to attach to an email.')
            : result.reason === 'discarded'
              ? discardedText
              : t('chatFiles.attachFailed', 'The file could not be attached to your email.')
        );
      }
    });

  if (!file) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneHeader
          title={t('chatFiles.title', 'Files')}
          headingId={chrome?.headingId}
          headingRef={chrome?.headingRef}
          back={chrome?.back}
          expand={chrome?.expand}
          close={chrome?.close}
          paneWidth={chrome?.paneWidth}
          full={chrome?.full}
        />
        {status === 'ready' || status === 'error' ? (
          <output
            className="block p-4 text-sm text-gray-700 dark:text-gray-200"
            data-testid="uploaded-file-gone"
          >
            {status === 'error'
              ? t('chatFiles.loadFailed', 'The uploaded files could not be loaded.')
              : t('chatFiles.fileGone', 'This file is no longer in the chat.')}
          </output>
        ) : (
          <p className="p-4 text-sm text-gray-500 dark:text-gray-400" role="status">
            {t('chatFiles.loading', 'Loading the uploaded files…')}
          </p>
        )}
      </div>
    );
  }

  const storage = uploadedStorageState(file);
  const canDownloadOriginal = access !== 'extracted_text' && storage === 'original';
  const hasText = file.origin !== 'image';
  const canAttach = Boolean(mailAttach?.available) && storage === 'original';
  const attachAction = {
    key: 'attach',
    icon: 'envelope',
    label: t('chatFiles.attachToEmail', 'Attach to email'),
    onClick: attachToMail,
    testId: 'uploaded-attach-to-email'
  };
  const kind = uploadedViewKind(file);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="uploaded-file-detail">
      <PaneHeader
        title={file.name}
        badge={uploadedFileBadge(file)}
        headingId={chrome?.headingId}
        headingRef={chrome?.headingRef}
        back={chrome?.back}
        switcher={chrome?.switcher}
        copy={hasText ? { onCopy: copyText, menu: [] } : null}
        download={
          canDownloadOriginal
            ? {
                key: 'original',
                icon: 'download',
                label: t('chatFiles.downloadOriginal', 'Download original'),
                onClick: downloadOriginal,
                testId: 'uploaded-download-original'
              }
            : null
        }
        extra={
          canAttach && attachProminent ? (
            <button
              type="button"
              className={GHOST_BUTTON}
              disabled={busy !== null}
              onClick={attachToMail}
              data-testid="uploaded-attach-to-email"
            >
              <Icon name="envelope" size="sm" />
              {t('chatFiles.attachToEmail', 'Attach to email')}
            </button>
          ) : null
        }
        expand={chrome?.expand}
        close={chrome?.close}
        more={[
          ...(canAttach && !attachProminent ? [attachAction] : []),
          ...(hasText
            ? [
                {
                  key: 'text',
                  icon: 'document-text',
                  label: t('chatFiles.downloadText', 'Download text'),
                  onClick: downloadText,
                  testId: 'uploaded-download-text'
                }
              ]
            : []),
          ...(chrome?.more || []),
          ...(source.remove
            ? [
                {
                  key: 'delete',
                  icon: 'trash',
                  label: t('chatFiles.delete', 'Delete file'),
                  onClick: () => setConfirmDelete(true),
                  danger: true,
                  testId: 'uploaded-delete'
                }
              ]
            : [])
        ]}
        paneWidth={chrome?.paneWidth}
        full={chrome?.full}
        notice={notice?.tone === 'info' ? notice.text : null}
      />
      {confirmDelete && (
        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 dark:border-red-800 dark:bg-red-900/20">
          <span className="mr-auto text-sm text-red-800 dark:text-red-200">
            {t('chatFiles.deleteConfirm', 'Delete {{name}}?', { name: file.name })}
          </span>
          <button
            type="button"
            className={DANGER_BUTTON}
            disabled={busy !== null}
            onClick={deleteFile}
            data-testid="uploaded-delete-confirm"
          >
            <Icon name="trash" size="sm" />
            {t('chatFiles.delete', 'Delete file')}
          </button>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => setConfirmDelete(false)}
          >
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      )}
      {notice?.tone === 'error' && (
        <p
          role="alert"
          className="flex-none bg-red-50 px-3 py-1 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200"
        >
          {notice.text}
        </p>
      )}
      <SelectionScope
        enabled={kind !== 'image' && kind !== 'pdf'}
        onQuote={chrome?.onQuote}
        source={{ kind: 'file', id: file.id, name: file.name }}
        bottomPadding={chrome?.bottomPadding || 0}
        className="min-h-0 flex-1 overflow-y-auto p-4"
        innerClassName={chrome?.full ? 'mx-auto w-full max-w-[52rem]' : ''}
        testId="uploaded-file-body"
      >
        <p className="mb-2 text-xs text-gray-600 dark:text-gray-300">
          {file.createdAt &&
            new Date(file.createdAt).toLocaleString(i18n.language || undefined, {
              dateStyle: 'short',
              timeStyle: 'short'
            })}
          {file.canUseAsTemplate && (
            <span className="ml-2" data-testid="uploaded-template-hint">
              · {t('chatFiles.templateHint', 'The assistant can use this file as a template.')}
            </span>
          )}
          {file.truncated && (
            <span className="ml-2">
              · {t('chatFiles.truncated', 'Very long: the assistant reads the beginning.')}
            </span>
          )}
        </p>
        <UploadedPreview key={file.id} file={file} source={source} getBlob={getBlob} />
      </SelectionScope>
    </div>
  );
}
