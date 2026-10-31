// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import {
  DANGER_BUTTON_CLASS,
  HELP_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';

/**
 * One file of a document template (logo, letterhead, Word or PowerPoint
 * template, a font style): what is uploaded, and buttons to upload, replace
 * or remove it.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {string} [props.help]
 * @param {string} [props.fileName] - The stored file, if any.
 * @param {string} props.accept - `accept` of the file input.
 * @param {boolean} [props.busy]
 * @param {boolean} [props.disabled]
 * @param {(file: File) => void} props.onUpload
 * @param {() => void} [props.onRemove]
 * @param {import('react').ReactNode} [props.children] - Details of the file.
 */
export default function TemplateFileSlot({
  label,
  help,
  fileName,
  accept,
  busy = false,
  disabled = false,
  onUpload,
  onRemove,
  children
}) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const inputId = useId();
  const helpId = useId();

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <label htmlFor={inputId} className={LABEL_CLASS}>
            {label}
          </label>
          <p className="text-sm text-gray-700 dark:text-gray-300 break-all">
            {fileName ? (
              <span className="inline-flex items-center gap-1">
                <Icon
                  name="check-circle"
                  size="sm"
                  className="text-green-600 dark:text-green-400"
                />
                {fileName}
              </span>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">
                {t('admin.documentTemplates.files.none', 'No file')}
              </span>
            )}
          </p>
          {help && (
            <p id={helpId} className={HELP_CLASS}>
              {help}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={accept}
            className="sr-only"
            aria-describedby={help ? helpId : undefined}
            disabled={disabled || busy}
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onUpload(file);
            }}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
          >
            <Icon
              name={busy ? 'refresh' : 'upload'}
              size="sm"
              className={busy ? 'animate-spin' : ''}
            />
            {fileName
              ? t('admin.documentTemplates.files.replace', 'Replace')
              : t('admin.documentTemplates.files.upload', 'Upload')}
          </button>
          {fileName && onRemove && (
            <button
              type="button"
              className={DANGER_BUTTON_CLASS}
              disabled={disabled || busy}
              onClick={onRemove}
              aria-label={t('admin.documentTemplates.files.removeNamed', 'Remove {{name}}', {
                name: label
              })}
            >
              <Icon name="trash" size="sm" />
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
