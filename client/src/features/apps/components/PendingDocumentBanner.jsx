// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const ERROR_STATUSES = new Set(['unavailable', 'noAccess', 'notFound']);

/**
 * Banner above the app picker while a document waits to be attached (`/apps?documentId=…`).
 * Says which document it is, offers to leave it out, and — while it is still going to be attached
 * — can narrow the picker to the apps that take documents.
 *
 * @param {Object} props
 * @param {string} props.status - `usePendingDocumentCheck().status`
 * @param {string} props.title - the document's name: its title, else the link's `prefill`, else ''
 * @param {() => void} props.onDismiss - drop the pending document and stay on the picker
 * @param {boolean} props.canRestrict - at least one app takes documents (else no toggle)
 * @param {boolean} props.restrict - the picker shows only those apps
 * @param {(value: boolean) => void} props.onRestrictChange
 */
function PendingDocumentBanner({
  status,
  title,
  onDismiss,
  canRestrict,
  restrict,
  onRestrictChange
}) {
  const { t } = useTranslation();
  const isError = ERROR_STATUSES.has(status);
  const name = title || t('pages.appsList.pendingDocument.untitled', 'the document');

  if (isError) {
    const errorText = {
      unavailable: t(
        'pages.appsList.pendingDocument.unavailable',
        'The system this document comes from is not available to you.'
      ),
      noAccess: t(
        'pages.appsList.pendingDocument.noAccess',
        'You do not have access to this document.'
      ),
      notFound: t(
        'pages.appsList.pendingDocument.notFound',
        'This document could not be found. It may have been moved or deleted.'
      )
    }[status];
    return (
      <div
        role="alert"
        className="mb-6 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-900/30 dark:text-red-100"
      >
        <Icon name="exclamation-circle" className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="font-medium">{errorText}</p>
          <p className="mt-0.5 opacity-80">
            {t(
              'pages.appsList.pendingDocument.continueWithout',
              'You can still pick an app and start without the document.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md px-2 py-1 text-sm font-medium underline hover:no-underline focus:outline-hidden focus:ring-2 focus:ring-red-500"
        >
          {t('pages.appsList.pendingDocument.dismiss', 'Dismiss')}
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 dark:border-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-100"
    >
      <Icon name="info" className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-medium break-words">
          {t('pages.appsList.pendingDocument.title', {
            defaultValue: 'Choose an app to open “{{name}}” in',
            name
          })}
        </p>
        <p className="mt-0.5 opacity-80">
          {t(
            'pages.appsList.pendingDocument.description',
            'The document is attached to the chat as soon as the app opens.'
          )}
        </p>
        {canRestrict && (
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={restrict}
              onChange={e => onRestrictChange(e.target.checked)}
              className="h-4 w-4 rounded-sm border-indigo-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              {t(
                'pages.appsList.pendingDocument.onlyDocumentApps',
                'Only show apps that can use this document'
              )}
            </span>
          </label>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-md px-2 py-1 text-sm font-medium underline hover:no-underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
      >
        {t('pages.appsList.pendingDocument.dismiss', 'Dismiss')}
      </button>
    </div>
  );
}

export default PendingDocumentBanner;
