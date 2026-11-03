// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import {
  deleteScheduledTaskFile,
  fetchScheduledTaskFiles,
  uploadScheduledTaskFile
} from '../../../api';
import { formatBytes } from '../../chat/utils/artifactFiles';
import { uploadErrorCode } from '../../chat/utils/chatFileUpload';
import { uploadedFileBadge, uploadedStorageState } from '../../chat/utils/uploadedFiles';

/**
 * Why a file could not be attached, in words.
 *
 * @param {string} code - Server error code (`QUOTA_*`, `UNSUPPORTED_TYPE`, …).
 * @param {Function} t
 * @returns {string}
 */
export function taskFileErrorText(code, t) {
  switch (code) {
    case 'QUOTA_FILE_BYTES':
      return t('scheduledTasks.files.errors.fileTooLarge', 'The file is too large.');
    case 'QUOTA_CHAT_FILES':
    case 'QUOTA_CHAT_BYTES':
      return t(
        'scheduledTasks.files.errors.taskQuota',
        'This task has reached its limit for attached files. Remove one first.'
      );
    case 'QUOTA_USER_BYTES':
    case 'QUOTA_SERVER_BYTES':
      return t('scheduledTasks.files.errors.storageFull', 'The file storage is full.');
    case 'UNSUPPORTED_TYPE':
      return t('scheduledTasks.files.errors.unsupported', 'This file type is not supported.');
    case 'NO_TEXT':
      return t('scheduledTasks.files.errors.noText', 'The file contains no readable text.');
    case 'SCAN_REJECTED':
      return t(
        'scheduledTasks.files.errors.rejected',
        'The file was rejected by the security scan.'
      );
    case 'UPLOADS_DISABLED':
      return t('scheduledTasks.files.errors.disabled', 'File uploads are switched off.');
    case 'BINARY_UPLOAD_NOT_ALLOWED':
      return t(
        'scheduledTasks.files.errors.textOnly',
        'This installation stores only text: files are read in the browser first.'
      );
    default:
      return t('scheduledTasks.files.errors.failed', 'The file could not be attached.');
  }
}

/**
 * Reference documents and templates attached to a scheduled task. Every run
 * sees them (their text is part of the run's prompt, and Word, PowerPoint, Excel
 * and PDF files can be used as templates or filled in by the run's tools); they
 * stay until the task or the file is deleted.
 *
 * On a saved task a file is uploaded at once. While the task is being created the
 * files are held in `staged` and the page uploads them once the task exists.
 *
 * @param {Object} props
 * @param {string|null} props.taskId - The saved task, or null while it is created.
 * @param {File[]} [props.staged] - Files chosen for a task that does not exist yet.
 * @param {(files: File[]) => void} [props.onStagedChange]
 * @param {string} [props.className] - Section classes of the editor.
 */
export default function TaskFilesSection({ taskId, staged = [], onStagedChange, className = '' }) {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const uploads = platformConfig?.uploads;
  const textOnlyMode = uploads?.storageMode === 'client_text_only';
  const inputRef = useRef(null);
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState(taskId ? 'loading' : 'ready');
  const [busy, setBusy] = useState(null); // name of the file being uploaded
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      const result = await fetchScheduledTaskFiles(taskId);
      setItems(Array.isArray(result?.items) ? result.items : []);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  if (uploads?.enabled === false) return null;

  const upload = async file => {
    setBusy(file.name);
    setError(null);
    try {
      await uploadScheduledTaskFile(taskId, file);
      await load();
    } catch (err) {
      setError(`${file.name}: ${taskFileErrorText(uploadErrorCode(err), t)}`);
    } finally {
      setBusy(null);
    }
  };

  const handlePick = async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (taskId) {
      // One at a time: the task's quota is checked per upload.
      for (const file of files) {
        await upload(file);
      }
    } else {
      onStagedChange?.([...staged, ...files]);
    }
  };

  const remove = async file => {
    setError(null);
    try {
      await deleteScheduledTaskFile(taskId, file.id);
      await load();
    } catch {
      setError(t('scheduledTasks.files.deleteFailed', 'The file could not be removed.'));
    }
  };

  const rows = taskId
    ? items.map(item => ({
        key: item.id,
        name: item.name,
        badge: uploadedFileBadge(item),
        detail: [
          formatBytes(item.bytes),
          uploadedStorageState(item) === 'original'
            ? t('scheduledTasks.files.original', 'Original saved')
            : t('scheduledTasks.files.textOnly', 'Text only'),
          item.canUseAsTemplate ? t('scheduledTasks.files.template', 'usable as a template') : null
        ]
          .filter(Boolean)
          .join(' · '),
        onRemove: () => remove(item)
      }))
    : staged.map((file, index) => ({
        key: `${file.name}-${file.size}-${index}`,
        name: file.name,
        badge: uploadedFileBadge({ name: file.name, mimeType: file.type }),
        detail: formatBytes(file.size),
        onRemove: () => onStagedChange?.(staged.filter((_, i) => i !== index))
      }));

  return (
    <section className={className} data-testid="task-files-section" aria-labelledby="task-files-h">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            id="task-files-h"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('scheduledTasks.files.title', 'Attached files')}
          </h2>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400 sm:max-w-xl">
            {t(
              'scheduledTasks.files.help',
              'Reference documents or templates every run can read, for example a style guide, a report template or a price list. They stay until you remove them or delete the task.'
            )}
          </p>
        </div>
        <div className="shrink-0">
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={handlePick}
            data-testid="task-files-input"
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null || textOnlyMode}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            <Icon name="paper-clip" size="sm" />
            {t('scheduledTasks.files.add', 'Attach files')}
          </button>
        </div>
      </div>

      {textOnlyMode && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t(
            'scheduledTasks.files.textOnlyMode',
            'This installation keeps only extracted text, so files cannot be attached to tasks here.'
          )}
        </p>
      )}
      {status === 'loading' && (
        <output className="block text-sm text-gray-500">{t('common.loading', 'Loading…')}</output>
      )}
      {status === 'error' && (
        <p className="text-sm text-red-600" role="alert">
          {t('scheduledTasks.files.loadFailed', 'The attached files could not be loaded.')}
        </p>
      )}
      {busy && (
        <output className="block text-sm text-gray-600 dark:text-gray-300">
          {t('scheduledTasks.files.uploading', 'Uploading {{name}}…', { name: busy })}
        </output>
      )}
      {error && (
        <p className="text-sm text-red-600" role="alert" data-testid="task-files-error">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700 rounded-md border border-gray-200 dark:border-gray-700">
          {rows.map(row => (
            <li key={row.key} className="flex items-center gap-3 px-3 py-2">
              <span className="rounded bg-gray-200 dark:bg-gray-600 px-1 text-[10px] font-semibold text-gray-700 dark:text-gray-100">
                {row.badge}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {row.name}
                </span>
                <span className="block truncate text-xs text-gray-600 dark:text-gray-400">
                  {row.detail}
                </span>
              </span>
              <button
                type="button"
                onClick={row.onRemove}
                className="shrink-0 p-1 text-gray-500 hover:text-red-600"
                aria-label={t('scheduledTasks.files.remove', 'Remove {{name}}', { name: row.name })}
              >
                <Icon name="trash" size="sm" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!taskId && staged.length > 0 && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {t('scheduledTasks.files.stagedHint', 'The files are attached when you save the task.')}
        </p>
      )}
    </section>
  );
}
