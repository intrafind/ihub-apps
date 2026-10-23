// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

/**
 * The text a web page would give the model, shown in the URL tab before the
 * page is added: read through the same reader a URL item is read with.
 *
 * Opening it for a page moves the focus to it (and scrolls it into view), so
 * a preview asked for from a row deep in the page list is not opened out of
 * sight; the picker gives the focus back on close.
 *
 * @param {Object} props
 * @param {{url: string, loading?: boolean, ok?: boolean, error?: string, title?: string,
 *   finalUrl?: string, text?: string, chars?: number, truncated?: boolean}} props.preview
 * @param {() => void} props.onClose
 * @returns {JSX.Element}
 */
function UrlPreviewPanel({ preview, onClose }) {
  const { t, i18n } = useTranslation();
  const sectionRef = useRef(null);
  const heading = preview.title || preview.url;

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    section.scrollIntoView?.({ block: 'nearest' });
    section.focus({ preventScroll: true });
  }, [preview.url]);

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label={t('projects.addItem.previewLabel', 'Extracted content')}
      className="rounded-lg border border-gray-200 dark:border-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
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
            <p className="text-xs text-gray-600 dark:text-gray-400 truncate">
              {preview.finalUrl && preview.finalUrl !== preview.url
                ? t('projects.addItem.previewRedirected', 'Read from {{url}}', {
                    url: preview.finalUrl
                  })
                : preview.url}
              {' · '}
              {t('projects.addItem.previewChars', {
                count: preview.chars ?? 0,
                formattedCount: (preview.chars ?? 0).toLocaleString(i18n?.language || undefined),
                defaultValue_one: '{{formattedCount}} character',
                defaultValue_other: '{{formattedCount}} characters'
              })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('projects.addItem.previewClose', 'Close the preview')}
          className="p-1 rounded text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>
      <p role="status" className="sr-only">
        {preview.loading
          ? t('projects.addItem.previewLoading', 'Reading the page...')
          : preview.ok
            ? t('projects.addItem.previewTitle', 'Extracted content: {{title}}', {
                title: heading
              })
            : ''}
      </p>
      <div className="p-3">
        {preview.loading && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
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
            {/* A scrolling text keyboard users must reach to scroll it (axe
                `scrollable-region-focusable`, WCAG 2.1.1). */}
            <pre
              role="region"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              aria-label={t('projects.addItem.previewText', 'Text of {{title}}', {
                title: heading
              })}
              className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 rounded-md p-3 border border-gray-200 dark:border-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {preview.text || t('projects.preview.empty', '(no text)')}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}

export default UrlPreviewPanel;
