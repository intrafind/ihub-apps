// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { renderMarkdown } from '../../../config/marked.config';
import { saveBlobAs } from '../../../utils/externalNavigation';
import { isOriginalDiscarded } from '../../../api/utils/fileErrors';
import ArtifactPreview from './ArtifactPreview';
import { formatBytes, saveName } from '../utils/artifactFiles';
import {
  extractedTextFileName,
  parseStructuredText,
  questionOfFiles,
  uploadedFileBadge,
  uploadedFileLook,
  uploadedStorageState,
  uploadedViewKind
} from '../utils/uploadedFiles';

const BUTTON =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium min-h-[2.25rem] disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY = `${BUTTON} border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700`;
const DANGER = `${BUTTON} border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30`;

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
        if (active) setText({ status: 'ready', text: result?.file?.text || '' });
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
 * The "Uploaded" tab of the Files drawer: the files the user (or an add-in)
 * put into the chat. A type badge, size, pages and storage state per file; a
 * preview; "Download original" (the original may be gone: only its text is kept
 * then), "Download text", "Delete file" and, in the Outlook task pane while a mail
 * is being written, "Attach to email".
 *
 * @param {Object} props
 * @param {Object[]} props.items - File descriptors.
 * @param {'loading'|'ready'|'error'} props.status
 * @param {Object} props.source
 * @param {(id: string) => Promise<{ file: Object }>} props.source.fetchText
 * @param {(id: string) => Promise<Blob>} props.source.fetchBlob
 * @param {(id: string) => Promise<unknown>} [props.source.remove] - Absent: read-only (a shared chat).
 * @param {() => void} [props.onChanged] - After a file was deleted.
 * @param {{ available: boolean, attach: (params: Object) => Promise<Object> }|null} [props.mailAttach]
 * @param {Object[]} [props.messages]
 * @param {string|null} [props.initialFileId] - Open this file first.
 * @param {'none'|'extracted_text'|'original'} [props.access] - On a shared chat: what the owner shared.
 */
export default function UploadedFilesTab({
  items,
  status,
  source,
  onChanged,
  mailAttach = null,
  messages,
  initialFileId = null,
  access = null
}) {
  const { t, i18n } = useTranslation();
  const [selectedId, setSelectedId] = useState(initialFileId);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const blobsRef = useRef(new Map());

  useEffect(() => {
    blobsRef.current = new Map();
  }, [source]);

  // A message's card names a file by id. When that file is no longer in the chat (it was deleted)
  // the drawer says so; it does not open another file in its place.
  const requested =
    items.find(item => item.id === selectedId) || items.find(item => item.id === initialFileId);
  const requestedGone =
    Boolean(initialFileId) && !requested && (selectedId === initialFileId || selectedId === null);
  const current = requested || (requestedGone ? null : items[0] || null);

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

  const questions = useMemo(() => questionOfFiles(items, messages), [items, messages]);

  const run = async (name, task) => {
    setBusy(name);
    setNotice(null);
    try {
      await task();
    } finally {
      setBusy(null);
    }
  };

  const downloadOriginal = file =>
    run('original', async () => {
      try {
        const blob = await getBlob(file.id);
        if (!saveBlobAs(blob, saveName(file.name))) throw new Error('save');
      } catch (error) {
        setNotice({
          tone: 'error',
          text: isOriginalDiscarded(error)
            ? t(
                'chatFiles.originalDiscarded',
                'The original file is no longer stored; only its text is kept. You can download the text instead.'
              )
            : t('chatArtifacts.downloadFailed', 'The download failed. Please try again.')
        });
      }
    });

  const downloadText = file =>
    run('text', async () => {
      try {
        const result = await source.fetchText(file.id);
        const blob = new Blob([result?.file?.text || ''], { type: 'text/plain;charset=utf-8' });
        if (!saveBlobAs(blob, extractedTextFileName(file))) throw new Error('save');
      } catch {
        setNotice({
          tone: 'error',
          text: t('chatArtifacts.downloadFailed', 'The download failed. Please try again.')
        });
      }
    });

  const deleteFile = file =>
    run('delete', async () => {
      try {
        await source.remove(file.id);
        setConfirmDelete(false);
        setSelectedId(null);
        onChanged?.();
      } catch {
        setNotice({
          tone: 'error',
          text: t('chatFiles.deleteFailed', 'The file could not be deleted. Please try again.')
        });
      }
    });

  const attachToMail = file =>
    run('attach', async () => {
      const result = await mailAttach.attach({ file, fetchBlob: () => getBlob(file.id) });
      setNotice(
        result.ok
          ? {
              tone: 'info',
              text: t('chatFiles.attached', 'Attached {{name}} to your email.', {
                name: result.filename
              })
            }
          : {
              tone: 'error',
              text:
                result.reason === 'tooLarge'
                  ? t('chatFiles.attachTooLarge', 'The file is too large to attach to an email.')
                  : result.reason === 'discarded'
                    ? t(
                        'chatFiles.originalDiscarded',
                        'The original file is no longer stored; only its text is kept. You can download the text instead.'
                      )
                    : t('chatFiles.attachFailed', 'The file could not be attached to your email.')
            }
      );
    });

  if (status === 'loading') {
    return (
      <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
        {t('chatFiles.loading', 'Loading the uploaded files…')}
      </p>
    );
  }
  if (status === 'error') {
    return (
      <p className="p-4 text-sm text-red-700 dark:text-red-400" role="alert">
        {t('chatFiles.loadFailed', 'The uploaded files could not be loaded.')}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="p-4 text-sm text-gray-600 dark:text-gray-300" data-testid="uploaded-empty">
        {access === 'none'
          ? t('chatFiles.notShared', 'The owner did not share the files attached to this chat.')
          : t(
              'chatFiles.empty',
              'No files uploaded to this chat yet. Documents, emails and pages you attach appear here.'
            )}
      </p>
    );
  }

  const storage = current ? uploadedStorageState(current) : null;
  const canDownloadOriginal = current && access !== 'extracted_text' && storage === 'original';

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row" data-testid="uploaded-files-tab">
      <ul
        className="lg:w-80 flex-none overflow-y-auto max-h-[40vh] lg:max-h-none border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-gray-700 py-1"
        aria-label={t('chatFiles.listLabel', 'Files uploaded to this chat')}
      >
        {items.map(item => {
          const look = uploadedFileLook(item);
          const state = uploadedStorageState(item);
          const isCurrent = item.id === current?.id;
          const question = questions.get(item.id);
          return (
            <li key={item.id} className={isCurrent ? 'bg-indigo-50 dark:bg-indigo-900/30' : ''}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(item.id);
                  setConfirmDelete(false);
                  setNotice(null);
                }}
                aria-current={isCurrent ? 'true' : undefined}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <span
                  className={`flex-none flex items-center justify-center w-8 h-8 rounded-md ${look.className}`}
                >
                  <Icon name={look.icon} size="sm" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                      title={item.name}
                    >
                      {item.name}
                    </span>
                    <span
                      className="flex-none rounded bg-gray-200 dark:bg-gray-600 px-1 text-[10px] font-semibold text-gray-700 dark:text-gray-100"
                      data-testid="uploaded-badge"
                    >
                      {uploadedFileBadge(item)}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-gray-600 dark:text-gray-300">
                    {[
                      formatBytes(item.bytes),
                      Number.isFinite(item.pages)
                        ? t('chatFiles.pages', '{{count}} pages', { count: item.pages })
                        : null,
                      state === 'original'
                        ? t('chatFiles.stateOriginal', 'Original saved')
                        : state === 'expired'
                          ? t('chatFiles.stateExpired', 'Original removed')
                          : t('chatFiles.stateTextOnly', 'Text only'),
                      question
                        ? t('chatFiles.question', 'Question {{number}}', { number: question })
                        : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <section
        className="flex-1 min-w-0 min-h-0 overflow-y-auto p-4"
        aria-label={t('chatArtifacts.previewLabel', 'Preview')}
      >
        {requestedGone && (
          <p
            className="text-sm text-gray-700 dark:text-gray-200"
            role="status"
            data-testid="uploaded-file-gone"
          >
            {t('chatFiles.fileGone', 'This file is no longer in the chat.')}
          </p>
        )}
        {current && (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <h3
                className="mr-auto min-w-0 break-words text-base font-semibold text-gray-900 dark:text-gray-100"
                title={current.name}
              >
                {current.name}
              </h3>
              {mailAttach?.available && storage === 'original' && (
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={busy !== null}
                  onClick={() => attachToMail(current)}
                  data-testid="uploaded-attach-to-email"
                >
                  <Icon name="envelope" size="sm" />
                  {t('chatFiles.attachToEmail', 'Attach to email')}
                </button>
              )}
              {canDownloadOriginal && (
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={busy !== null}
                  onClick={() => downloadOriginal(current)}
                  data-testid="uploaded-download-original"
                >
                  <Icon name="download" size="sm" />
                  {t('chatFiles.downloadOriginal', 'Download original')}
                </button>
              )}
              <button
                type="button"
                className={SECONDARY}
                disabled={busy !== null}
                onClick={() => downloadText(current)}
                data-testid="uploaded-download-text"
              >
                <Icon name="document-text" size="sm" />
                {t('chatFiles.downloadText', 'Download text')}
              </button>
              {source.remove &&
                (confirmDelete ? (
                  <span className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      className={DANGER}
                      disabled={busy !== null}
                      onClick={() => deleteFile(current)}
                      data-testid="uploaded-delete-confirm"
                    >
                      {t('chatFiles.deleteConfirm', 'Delete {{name}}?', { name: current.name })}
                    </button>
                    <button
                      type="button"
                      className={SECONDARY}
                      onClick={() => setConfirmDelete(false)}
                    >
                      {t('common.cancel', 'Cancel')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={DANGER}
                    disabled={busy !== null}
                    onClick={() => setConfirmDelete(true)}
                    data-testid="uploaded-delete"
                  >
                    <Icon name="trash" size="sm" />
                    {t('chatFiles.delete', 'Delete file')}
                  </button>
                ))}
            </div>
            <p className="mb-2 text-xs text-gray-600 dark:text-gray-300">
              {new Date(current.createdAt).toLocaleString(i18n.language || undefined, {
                dateStyle: 'short',
                timeStyle: 'short'
              })}
              {current.canUseAsTemplate && (
                <span className="ml-2" data-testid="uploaded-template-hint">
                  · {t('chatFiles.templateHint', 'The assistant can use this file as a template.')}
                </span>
              )}
              {current.truncated && (
                <span className="ml-2">
                  · {t('chatFiles.truncated', 'Very long: the assistant reads the beginning.')}
                </span>
              )}
            </p>
            <output aria-live="polite" className="block empty:hidden">
              {notice && (
                <p
                  className={`mb-2 text-sm ${notice.tone === 'error' ? 'text-red-700 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'}`}
                >
                  {notice.text}
                </p>
              )}
            </output>
            <UploadedPreview key={current.id} file={current} source={source} getBlob={getBlob} />
          </>
        )}
      </section>
    </div>
  );
}
