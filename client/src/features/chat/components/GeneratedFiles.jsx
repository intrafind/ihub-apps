// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchChatArtifact } from '../../../api';
import { saveBlobAs } from '../../../utils/externalNavigation';
import { useArtifactFetcher } from '../contexts/ArtifactFetchContext';
import { useArtifactViewer } from '../contexts/ArtifactViewerContext';
import {
  artifactBadge,
  blobOfBase64,
  fileLookOf,
  formatBytes,
  isOpenable,
  saveName
} from '../utils/artifactFiles';

/**
 * One file a tool generated for the user, with a download button.
 *
 * The bytes come the way a generated picture's do: with the live turn
 * (`data`), or — once the answer is stored — as an artifact of the chat
 * (`document`, `code` or `archive`), fetched by id from the owner's route or, in a shared chat, the
 * share's (see `ArtifactFetchContext`).
 *
 * @param {Object} props
 * @param {Object} props.file - A descriptor from `shared/generatedFiles.js`.
 * @param {string} [props.chatId] - The chat a stored file belongs to.
 */
function GeneratedFileCard({ file, chatId }) {
  const { t } = useTranslation();
  const customFetch = useArtifactFetcher();
  const [state, setState] = useState(file.unavailable ? 'missing' : 'idle');
  const canFetch = Boolean(file.data || (file.stored && file.id && chatId));
  const viewer = useArtifactViewer();
  // A file with a preview opens in the viewer; the others (Office documents,
  // archives) keep the download button as their only action.
  const openable = Boolean(viewer && canFetch && state !== 'missing' && isOpenable(file));
  // Only a file the chat has stored can be shared; a live one has no id yet.
  const shareable = Boolean(
    viewer?.shareArtifact && file.stored && file.id && chatId && state !== 'missing'
  );

  const download = async () => {
    setState('loading');
    try {
      const blob = file.data
        ? blobOfBase64(file.data, file.mimeType)
        : await (customFetch || fetchChatArtifact)(chatId, file.id);
      setState(saveBlobAs(blob, saveName(file.name)) ? 'idle' : 'error');
    } catch (error) {
      setState(error?.response?.status === 404 || error?.status === 404 ? 'missing' : 'error');
    }
  };

  const look = fileLookOf(file);
  const typeLabel = artifactBadge(file);
  const details = [
    typeLabel,
    file.pages
      ? t('chatMessage.generatedFiles.pages', '{{count}} pages', { count: file.pages })
      : null,
    file.slides
      ? t('chatMessage.generatedFiles.slides', '{{count}} slides', { count: file.slides })
      : null,
    file.sheets
      ? t('chatMessage.generatedFiles.sheets', '{{count}} sheets', { count: file.sheets })
      : null,
    formatBytes(file.bytes)
  ]
    .filter(Boolean)
    .join(' · ');
  // Open in the workspace pane right now: the card shows it (aria-current).
  const active = openable && Boolean(viewer?.activeId) && viewer.activeId === file.id;
  const canDownload = canFetch && state !== 'missing';

  const info = (
    <>
      <span
        className={`flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-md ${look.className}`}
        aria-hidden="true"
      >
        <Icon name={look.icon} size="md" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span
          className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate"
          title={file.name}
        >
          {file.name}
        </span>
        <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">
          {state === 'missing' || !canFetch
            ? file.unavailable && file.unavailable !== 'expired'
              ? t('chatMessage.generatedFiles.notKept', 'This file was not kept with the chat')
              : t('chatMessage.generatedFiles.expired', 'This file is no longer available')
            : state === 'error'
              ? t('chatMessage.generatedFiles.failed', 'Download failed. Please try again.')
              : details}
        </span>
      </span>
    </>
  );

  // The quick actions: revealed on hover and focus where the card opens (the
  // card itself is the main action); always shown on touch screens and where
  // Download is the only thing a card can do.
  const reveal = openable
    ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'
    : '';
  const ACTION =
    'inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-600 dark:text-gray-300 hover:bg-indigo-50 hover:text-indigo-700 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60';

  return (
    <div
      data-testid="generated-file-card"
      data-active={active ? 'true' : undefined}
      className={`group relative flex items-center rounded-lg border max-w-md motion-safe:transition-colors ${
        active
          ? 'border-indigo-500 ring-1 ring-indigo-500/30 bg-indigo-50/40 dark:bg-indigo-900/20'
          : `border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 ${openable ? 'hover:border-indigo-300 dark:hover:border-indigo-600 hover:shadow-xs' : ''}`
      }`}
    >
      {openable ? (
        <button
          type="button"
          onClick={() => viewer.openArtifact(file)}
          data-testid="generated-file-open"
          aria-current={active ? 'true' : undefined}
          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
            shareable || canDownload ? 'pr-20' : ''
          }`}
        >
          {info}
          <span className="sr-only">{t('chatMessage.generatedFiles.open', 'Open')}</span>
          <Icon
            name="chevron-right"
            size="sm"
            className="flex-shrink-0 text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-300"
          />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2">{info}</div>
      )}
      <div
        className={`flex flex-shrink-0 items-center gap-0.5 ${openable ? 'absolute right-8 top-1/2 -translate-y-1/2' : 'pr-2'} ${reveal}`}
      >
        {shareable && (
          <button
            type="button"
            onClick={() => viewer.shareArtifact(file)}
            data-testid="generated-file-share"
            className={ACTION}
            aria-label={t('chatMessage.generatedFiles.shareNamed', 'Share {{name}}', {
              name: file.name
            })}
            title={t('chatMessage.generatedFiles.share', 'Share')}
          >
            <Icon name="share" size="sm" />
          </button>
        )}
        {canDownload && (
          <button
            type="button"
            onClick={download}
            disabled={state === 'loading'}
            className={ACTION}
            aria-label={t('chatMessage.generatedFiles.downloadNamed', 'Download {{name}}', {
              name: file.name
            })}
            title={t('chatMessage.generatedFiles.download', 'Download')}
          >
            <Icon
              name={state === 'loading' ? 'refresh' : 'download'}
              size="sm"
              className={state === 'loading' ? 'animate-spin' : ''}
            />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Download cards for the files an answer's tools generated.
 *
 * @param {Object} props
 * @param {Array<Object>} props.files - Descriptors (see shared/generatedFiles.js).
 * @param {string} [props.chatId] - The chat the message belongs to.
 */
export default function GeneratedFiles({ files, chatId }) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return (
    <div className="my-2 flex flex-col gap-2">
      {files.map((file, index) => (
        <GeneratedFileCard key={file.id || `unavailable-${index}`} file={file} chatId={chatId} />
      ))}
    </div>
  );
}
