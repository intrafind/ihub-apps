// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

/**
 * The text a web page would give the model, shown in the URL tab before the
 * page is added: read through the same reader a URL item is read with.
 *
 * @param {Object} props
 * @param {{url: string, loading?: boolean, ok?: boolean, error?: string, title?: string,
 *   finalUrl?: string, text?: string, chars?: number, truncated?: boolean}} props.preview
 * @param {() => void} props.onClose
 * @returns {JSX.Element}
 */
function UrlPreviewPanel({ preview, onClose }) {
  const { t } = useTranslation();
  const heading = preview.title || preview.url;
  return (
    <section
      aria-label={t('projects.addItem.previewLabel', 'Extracted content')}
      className="rounded-lg border border-gray-200 dark:border-gray-700"
      data-testid="url-preview"
    >
      <div className="flex items-start gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {t('projects.addItem.previewTitle', 'Extracted content: {{title}}', {
              title: heading
            })}
          </p>
          {!preview.loading && preview.ok && (
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {preview.finalUrl && preview.finalUrl !== preview.url
                ? t('projects.addItem.previewRedirected', 'Read from {{url}}', {
                    url: preview.finalUrl
                  })
                : preview.url}
              {' · '}
              {t('projects.addItem.previewChars', '{{count}} characters', {
                count: (preview.chars ?? 0).toLocaleString()
              })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('projects.addItem.previewClose', 'Close the preview')}
          className="text-gray-500 hover:text-gray-600 dark:hover:text-gray-200"
        >
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      <div className="p-3">
        {preview.loading && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('projects.addItem.previewLoading', 'Reading the page...')}
          </p>
        )}
        {!preview.loading && !preview.ok && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {t('projects.addItem.urlFailed', 'The page cannot be read: {{error}}', {
              error: preview.error || ''
            })}
          </p>
        )}
        {!preview.loading && preview.ok && (
          <>
            {preview.truncated && (
              <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
                {t(
                  'projects.addItem.previewTruncated',
                  'The page is longer: only this part is given to the model.'
                )}
              </p>
            )}
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 rounded-md p-3 border border-gray-200 dark:border-gray-700">
              {preview.text || t('projects.preview.empty', '(no text)')}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}

export default UrlPreviewPanel;
