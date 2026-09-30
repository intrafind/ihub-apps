import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchGeneratedFile } from '../../../api';
import { saveBlobAs } from '../../../utils/externalNavigation';

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One file a tool generated for the user, with a download button.
 *
 * @param {Object} props
 * @param {{ id: string, name: string, mimeType: string, bytes: number, pages?: number }} props.file
 * @param {boolean} [props.readOnly] - Shared chat: the file belongs to the
 *   chat's owner and is not part of the share, so it is only named.
 */
function GeneratedFileCard({ file, readOnly = false }) {
  const { t } = useTranslation();
  const [state, setState] = useState('idle');

  const download = async () => {
    setState('loading');
    try {
      const blob = await fetchGeneratedFile(file.id);
      setState(saveBlobAs(blob, file.name) ? 'idle' : 'error');
    } catch (error) {
      setState(error?.response?.status === 404 ? 'missing' : 'error');
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
          {state === 'missing'
            ? t('chatMessage.generatedFiles.expired', 'This file is no longer available')
            : state === 'error'
              ? t('chatMessage.generatedFiles.failed', 'Download failed. Please try again.')
              : readOnly
                ? t('chatMessage.generatedFiles.notShared', 'Not included in the shared chat')
                : details}
        </div>
      </div>
      {!readOnly && state !== 'missing' && (
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
 * @param {boolean} [props.readOnly]
 */
export default function GeneratedFiles({ files, readOnly = false }) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return (
    <div className="my-2 flex flex-col gap-2">
      {files.map(file => (
        <GeneratedFileCard key={file.id} file={file} readOnly={readOnly} />
      ))}
    </div>
  );
}
