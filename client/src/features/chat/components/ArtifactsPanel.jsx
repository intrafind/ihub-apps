// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useFocusTrap } from '../../../shared/hooks/useFocusTrap';
import { saveBlobAs } from '../../../utils/externalNavigation';
import ArtifactPreview from './ArtifactPreview';
import {
  artifactDisplayName,
  fileLookOf,
  formatBytes,
  isTextArtifact,
  saveName,
  zipErrorCode
} from '../utils/artifactFiles';

/**
 * Which answer of the conversation produced each artifact, and which finished
 * answers produced any.
 *
 * Keyed by `runId`: a stored descriptor carries the run that made it, and so
 * does every answer, live or reloaded. An artifact id alone would not do: a
 * live answer knows its files only by the ids they had before they were
 * stored. Artifact ids a stored message names are kept as a fallback for a
 * descriptor without a run.
 *
 * @param {Object[]} messages
 * @returns {{ byRun: Map<string, number>, byId: Map<string, number>, producedRuns: string[] }}
 */
function answerIndex(messages) {
  const byRun = new Map();
  const byId = new Map();
  const producedRuns = [];
  let answer = 0;
  for (const message of messages || []) {
    if (message?.role !== 'assistant' || message.isGreeting) continue;
    answer += 1;
    if (message.runId && !byRun.has(message.runId)) byRun.set(message.runId, answer);
    for (const artifact of message.artifacts || []) {
      if (artifact?.id && !byId.has(artifact.id)) byId.set(artifact.id, answer);
    }
    const produced =
      message.artifacts?.length > 0 ||
      message.generatedFiles?.length > 0 ||
      message.images?.length > 0;
    if (produced && message.runId && !message.loading) producedRuns.push(message.runId);
  }
  return { byRun, byId, producedRuns };
}

/** How long to wait before asking once more for an answer's files the list lacks. */
const RELIST_DELAY_MS = 1500;

function formatDate(value, language) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(language || undefined, {
      dateStyle: 'short',
      timeStyle: 'short'
    });
  } catch {
    return '';
  }
}

const BUTTON =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium min-h-[2.25rem] disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY = `${BUTTON} border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700`;
const PRIMARY = `${BUTTON} bg-indigo-600 text-white hover:bg-indigo-700`;

/**
 * Everything a chat produced, in a drawer: generated pictures, documents,
 * code and archives. Each can be previewed, downloaded and — text — copied;
 * several, or all, download as one ZIP the server builds.
 *
 * The panel does not know whose chat it is: the page hands it a `source`,
 * the owner's chat routes or a share's, so a shared chat gets the same panel
 * with exactly the files its snapshot named.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {Object} props.source
 * @param {() => Promise<{ items: Object[] }>} props.source.list - The descriptors.
 * @param {(id: string) => Promise<Blob>} props.source.fetchBlob - One artifact's bytes.
 * @param {(ids?: string[]) => Promise<Blob>} props.source.zip - Several (or all) as a ZIP.
 * @param {string} [props.zipName] - Download name of an archive, without `.zip`.
 * @param {Object[]} [props.messages] - The conversation, to say which answer made a file.
 *   A change in the artifacts it names lists the files again, so a file an
 *   answer adds while the panel is open shows up.
 */
export default function ArtifactsPanel({
  isOpen,
  onClose,
  source,
  zipName = 'artifacts',
  messages
}) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const containerRef = useRef(null);
  const closeRef = useRef(null);
  const selectAllRef = useRef(null);
  const blobsRef = useRef(new Map());
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('loading');
  const [selected, setSelected] = useState(() => new Set());
  const [previewId, setPreviewId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  // The element that opened the panel, which gets focus back when it closes.
  const openerRef = useRef(typeof document === 'undefined' ? null : document.activeElement);

  // Tab stays inside the panel. Focus in and back out is handled below: the
  // hook's own return runs in a microtask on every cleanup, so a development
  // double-run of the effects would end with focus outside the dialog.
  useFocusTrap(containerRef, { isActive: isOpen, returnFocusOnDeactivate: false });

  useEffect(() => {
    if (!isOpen) return undefined;
    const opener = openerRef.current;
    // After the trap's own move, and after a restore a re-run queued.
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      queueMicrotask(() => {
        if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
      });
    };
  }, [isOpen]);

  const answers = useMemo(() => answerIndex(messages), [messages]);
  // Changes when an answer that produced a picture or a file has finished,
  // so a file made while the panel is open shows up in it.
  const listKey = answers.producedRuns.join(',');

  // A new source is a different chat: nothing cached applies to it.
  useEffect(() => {
    blobsRef.current = new Map();
  }, [source]);

  useEffect(() => {
    if (!isOpen) return undefined;
    let active = true;
    let retry = null;
    const expected = listKey ? listKey.split(',') : [];
    // A refresh keeps the list on screen while it asks again.
    setStatus(previous => (previous === 'ready' ? previous : 'loading'));
    const load = attempt =>
      source
        .list()
        .then(result => {
          if (!active) return;
          const list = Array.isArray(result?.items) ? result.items : [];
          // An answer that just finished is stored a moment after the client
          // sees it end: ask once more when its files are not listed yet.
          const listed = new Set(list.map(item => item.runId).filter(Boolean));
          if (attempt === 0 && expected.some(runId => !listed.has(runId))) {
            retry = setTimeout(() => load(1), RELIST_DELAY_MS);
          }
          setItems(list);
          setSelected(previous => new Set([...previous].filter(id => list.some(i => i.id === id))));
          setPreviewId(previous =>
            list.some(item => item.id === previous) ? previous : list[0]?.id || null
          );
          setStatus('ready');
        })
        .catch(() => {
          if (active) setStatus('error');
        });
    load(0);
    return () => {
      active = false;
      if (retry) clearTimeout(retry);
    };
  }, [isOpen, source, listKey]);

  // Escape closes the panel, wherever focus is inside it.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const getBlob = useCallback(
    id => {
      if (!blobsRef.current.has(id)) {
        const pending = source.fetchBlob(id);
        // A failed read is not cached: the next attempt asks again.
        pending.catch(() => blobsRef.current.delete(id));
        blobsRef.current.set(id, pending);
      }
      return blobsRef.current.get(id);
    },
    [source]
  );

  const preview = items.find(item => item.id === previewId) || null;
  const allSelected = items.length > 0 && selected.size === items.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.size > 0 && !allSelected;
    }
  }, [selected, allSelected]);

  if (!isOpen) return null;

  const toggle = id =>
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map(item => item.id)));

  const download = async artifact => {
    setBusy('download');
    setNotice(null);
    try {
      const blob = await getBlob(artifact.id);
      if (!saveBlobAs(blob, saveName(artifactDisplayName(artifact)))) throw new Error('save');
    } catch {
      setNotice({
        tone: 'error',
        text: t('chatArtifacts.downloadFailed', 'The download failed. Please try again.')
      });
    } finally {
      setBusy(null);
    }
  };

  const copy = async artifact => {
    setBusy('copy');
    setNotice(null);
    try {
      const text = await (await getBlob(artifact.id)).text();
      await navigator.clipboard.writeText(text);
      setNotice({ tone: 'info', text: t('chatArtifacts.copied', 'Copied to the clipboard.') });
    } catch {
      setNotice({
        tone: 'error',
        text: t('chatArtifacts.copyFailed', 'The content could not be copied.')
      });
    } finally {
      setBusy(null);
    }
  };

  const downloadZip = async ids => {
    setBusy(ids ? 'zip-selected' : 'zip-all');
    setNotice({
      tone: 'info',
      text: t('chatArtifacts.zipPreparing', 'Preparing the ZIP archive…')
    });
    try {
      const blob = await source.zip(ids);
      if (!saveBlobAs(blob, `${zipName}.zip`)) throw new Error('save');
      setNotice(null);
    } catch (error) {
      const code = await zipErrorCode(error);
      setNotice({
        tone: 'error',
        text:
          code === 'too-many-files'
            ? t(
                'chatArtifacts.zipTooMany',
                'Too many files for one ZIP archive. Select fewer files.'
              )
            : code === 'too-large'
              ? t(
                  'chatArtifacts.zipTooLarge',
                  'The files are too large for one ZIP archive. Select fewer files.'
                )
              : t(
                  'chatArtifacts.zipFailed',
                  'The ZIP archive could not be created. Please try again.'
                )
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" role="presentation" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid="artifacts-panel"
        className="relative h-full w-full sm:max-w-4xl bg-white dark:bg-gray-800 shadow-xl flex flex-col"
      >
        <header className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
          <h2 id={headingId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('chatArtifacts.title', 'Artifacts')}
            {status === 'ready' && (
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                {t('chatArtifacts.count', '{{count}} files', { count: items.length })}
              </span>
            )}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="p-2 rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            aria-label={t('chatArtifacts.close', 'Close artifacts')}
          >
            <Icon name="x" size="md" />
          </button>
        </header>

        {status === 'ready' && items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-gray-700 px-4 py-2">
            <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100 mr-auto min-h-[2.25rem]">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-4 w-4 rounded border-gray-400"
              />
              {t('chatArtifacts.selectAll', 'Select all')}
            </label>
            <button
              type="button"
              className={SECONDARY}
              disabled={selected.size === 0 || busy !== null}
              onClick={() => downloadZip(items.filter(i => selected.has(i.id)).map(i => i.id))}
            >
              <Icon name="archive-box" size="sm" />
              {t('chatArtifacts.downloadSelected', 'Download selected (.zip)')}
              {selected.size > 0 && <span aria-hidden="true">· {selected.size}</span>}
            </button>
            <button
              type="button"
              className={PRIMARY}
              disabled={busy !== null}
              onClick={() => downloadZip(undefined)}
            >
              <Icon name="download" size="sm" />
              {t('chatArtifacts.downloadAll', 'Download all (.zip)')}
            </button>
          </div>
        )}

        <div aria-live="polite" role="status" className="px-4 empty:hidden">
          {notice && (
            <p
              className={`my-2 text-sm ${notice.tone === 'error' ? 'text-red-700 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'}`}
            >
              {notice.text}
            </p>
          )}
        </div>

        {status === 'loading' && (
          <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
            {t('chatArtifacts.loading', 'Loading the files of this chat…')}
          </p>
        )}
        {status === 'error' && (
          <p className="p-4 text-sm text-red-700 dark:text-red-400" role="alert">
            {t('chatArtifacts.loadFailed', 'The files of this chat could not be loaded.')}
          </p>
        )}
        {status === 'ready' && items.length === 0 && (
          <p className="p-4 text-sm text-gray-600 dark:text-gray-300">
            {t(
              'chatArtifacts.empty',
              'This chat has no files yet. Files, pictures and documents the assistant creates appear here.'
            )}
          </p>
        )}

        {status === 'ready' && items.length > 0 && (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
            <ul
              className="lg:w-80 flex-none overflow-y-auto max-h-[40vh] lg:max-h-none border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-gray-700 py-1"
              aria-label={t('chatArtifacts.listLabel', 'Files of this chat')}
            >
              {items.map(item => {
                const name = artifactDisplayName(item);
                const look = fileLookOf(item);
                const answer =
                  (item.runId && answers.byRun.get(item.runId)) || answers.byId.get(item.id);
                const current = item.id === previewId;
                return (
                  <li
                    key={item.id}
                    className={`flex items-center gap-2 px-3 py-1.5 ${current ? 'bg-indigo-50 dark:bg-indigo-900/30' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                      aria-label={t('chatArtifacts.selectNamed', 'Select {{name}}', { name })}
                      className="h-4 w-4 flex-none rounded border-gray-400"
                    />
                    <button
                      type="button"
                      onClick={() => setPreviewId(item.id)}
                      aria-current={current ? 'true' : undefined}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left rounded-md p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <span
                        className={`flex-none flex items-center justify-center w-8 h-8 rounded-md ${look.className}`}
                      >
                        <Icon name={look.icon} size="sm" />
                      </span>
                      <span className="min-w-0">
                        <span
                          className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                          title={name}
                        >
                          {name}
                        </span>
                        <span className="block truncate text-xs text-gray-600 dark:text-gray-300">
                          {[
                            formatBytes(item.bytes),
                            answer
                              ? t('chatArtifacts.fromAnswer', 'Answer {{number}}', {
                                  number: answer
                                })
                              : null,
                            formatDate(item.createdAt, i18n.language)
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
              {preview && (
                <>
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <h3
                      className="mr-auto min-w-0 truncate text-base font-semibold text-gray-900 dark:text-gray-100"
                      title={artifactDisplayName(preview)}
                    >
                      {artifactDisplayName(preview)}
                    </h3>
                    {isTextArtifact(preview) && (
                      <button
                        type="button"
                        className={SECONDARY}
                        disabled={busy !== null}
                        onClick={() => copy(preview)}
                      >
                        <Icon name="copy" size="sm" />
                        {t('chatArtifacts.copy', 'Copy')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={SECONDARY}
                      disabled={busy !== null}
                      onClick={() => download(preview)}
                      aria-label={t('chatArtifacts.downloadNamed', 'Download {{name}}', {
                        name: artifactDisplayName(preview)
                      })}
                    >
                      <Icon name="download" size="sm" />
                      {t('chatArtifacts.download', 'Download')}
                    </button>
                  </div>
                  <ArtifactPreview key={preview.id} artifact={preview} getBlob={getBlob} />
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
