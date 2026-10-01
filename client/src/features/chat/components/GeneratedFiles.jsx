import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchChatArtifact } from '../../../api';
import { saveBlobAs } from '../../../utils/externalNavigation';
import { useArtifactFetcher } from '../contexts/ArtifactFetchContext';

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function blobOfBase64(data, mimeType) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * One file a tool generated for the user, with a download button.
 *
 * The bytes come the way a generated picture's do: with the live turn
 * (`data`), or — once the answer is stored — as a `document` artifact of the
 * chat, fetched by id from the owner's route or, in a shared chat, the
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

  const download = async () => {
    setState('loading');
    try {
      const blob = file.data
        ? blobOfBase64(file.data, file.mimeType)
        : await (customFetch || fetchChatArtifact)(chatId, file.id);
      setState(saveBlobAs(blob, file.name) ? 'idle' : 'error');
    } catch (error) {
      setState(error?.response?.status === 404 || error?.status === 404 ? 'missing' : 'error');
    }
  };

  const details = [
    file.pages
      ? t('chatMessage.generatedFiles.pages', '{{count}} pages', { count: file.pages })
      : null,
    formatBytes(file.bytes)
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 max-w-md">
      <div className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-md bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400">
        <Icon name="document-text" size="md" />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate"
          title={file.name}
        >
          {file.name}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {state === 'missing' || !canFetch
            ? file.unavailable && file.unavailable !== 'expired'
              ? t('chatMessage.generatedFiles.notKept', 'This file was not kept with the chat')
              : t('chatMessage.generatedFiles.expired', 'This file is no longer available')
            : state === 'error'
              ? t('chatMessage.generatedFiles.failed', 'Download failed. Please try again.')
              : details}
        </div>
      </div>
      {canFetch && state !== 'missing' && (
        <button
          type="button"
          onClick={download}
          disabled={state === 'loading'}
          className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-60"
          aria-label={t('chatMessage.generatedFiles.downloadNamed', 'Download {{name}}', {
            name: file.name
          })}
        >
          <Icon
            name={state === 'loading' ? 'refresh' : 'download'}
            size="sm"
            className={state === 'loading' ? 'animate-spin' : ''}
          />
          {t('chatMessage.generatedFiles.download', 'Download')}
        </button>
      )}
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
