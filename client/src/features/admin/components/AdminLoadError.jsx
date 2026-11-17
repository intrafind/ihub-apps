// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const RETRY_BUTTON_CLASS =
  'mt-3 inline-flex items-center gap-1.5 rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/40 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

const NEUTRAL_BUTTON_CLASS =
  'mt-3 inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900';

/**
 * The error panel of the admin area: a page's data failed to load, or a save
 * failed. One look everywhere, announced to screen readers as an alert, with
 * text that meets the contrast ratio on the red panel.
 *
 * Only the title and the text are the live region (`role="alert"`); the button
 * is outside it, so a "Retry in N s" countdown is not re-announced every second.
 * While Retry waits it is `aria-disabled` (not `disabled`), so a focused Retry
 * keeps focus after its own click hit a 429.
 *
 * Two ways to use it:
 * - **Load failure of a named resource** (pass `resourceLabel`): the title reads
 *   "Couldn't load {resource}" and the text ends with "Nothing was changed.".
 *   `status` 403 shows a neutral "You can't view {resource}" without Retry,
 *   404 a neutral "not found" (pass `action` for "Back to …"), 429 a
 *   "Too many requests" text. Prefer `onRetry`, which re-runs the failed load in
 *   place; `retryAfterSeconds` makes Retry inert with a "Retry in N s" countdown.
 * - **Free text** (`title` + `message`), as before.
 *
 * Without `onRetry` and `action`, the button reloads the page (the old default).
 *
 * @param {object} props
 * @param {string} [props.message] - The error message (the problem+json `detail`)
 * @param {string} [props.title] - What failed, e.g. "Error loading tools"; defaults to
 *   "Couldn't load {resource}" with `resourceLabel`, else "Error"
 * @param {string} [props.resourceLabel] - What failed to load, e.g. "authentication settings"
 * @param {number|null} [props.status] - HTTP status of the failed load (403 and 404 change the panel)
 * @param {() => (void|Promise<void>)} [props.onRetry] - Re-runs the failed load in place
 * @param {number} [props.retryAfterSeconds=0] - Seconds until Retry may be pressed
 * @param {boolean} [props.retrying=false] - A retry is running (button shows "Retrying…")
 * @param {boolean} [props.framed=true] - Wrap the panel in the admin page container
 *   (a page that shows nothing but the error). Pass false for a banner inside a page.
 * @param {{label: string, onClick: function}|null} [props.action] - Replaces the "Retry"
 *   button, e.g. "Back to Prompts"; null shows no button
 * @param {string} [props.className] - Extra classes for the panel, e.g. a bottom margin
 */
function AdminLoadError({
  message,
  title,
  resourceLabel,
  status = null,
  onRetry,
  retryAfterSeconds = 0,
  retrying = false,
  framed = true,
  action,
  className = ''
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);

  const forbidden = status === 403;
  const notFound = status === 404;
  const neutral = Boolean(resourceLabel) && (forbidden || notFound);
  const busy = pending || retrying;

  let heading = title;
  if (!heading && resourceLabel) {
    if (forbidden) {
      heading = t('admin.load.forbiddenTitle', "You can't view {{resource}}", {
        resource: resourceLabel
      });
    } else if (notFound) {
      heading = t('admin.load.notFoundTitle', 'Not found: {{resource}}', {
        resource: resourceLabel
      });
    } else {
      heading = t('admin.load.title', "Couldn't load {{resource}}", { resource: resourceLabel });
    }
  }
  heading = heading ?? t('common.error', 'Error');

  let body = message;
  if (resourceLabel) {
    if (forbidden) {
      body = t('admin.load.forbidden', 'Your account has no access to this page.');
    } else if (notFound) {
      body = t('admin.load.notFound', 'It may have been deleted or renamed.');
    } else {
      const detail =
        status === 429 ? t('admin.load.rateLimited', 'Too many requests right now.') : message;
      body = [detail, t('admin.load.nothingChanged', 'Nothing was changed.')]
        .filter(Boolean)
        .join(' ');
    }
  }

  const handleRetry = async () => {
    if (busy || retryAfterSeconds > 0) return;
    setPending(true);
    try {
      await onRetry();
    } finally {
      setPending(false);
    }
  };

  let button = null;
  if (action) {
    button = (
      <button
        type="button"
        onClick={action.onClick}
        className={neutral ? NEUTRAL_BUTTON_CLASS : RETRY_BUTTON_CLASS}
      >
        {action.label}
      </button>
    );
  } else if (action === null || neutral) {
    // No button asked for; or Retry cannot grant access or bring a deleted resource back.
    button = null;
  } else if (onRetry) {
    const waiting = retryAfterSeconds > 0;
    let label = t('admin.load.retry', 'Retry');
    if (busy) label = t('admin.load.retrying', 'Retrying…');
    else if (waiting) {
      label = t('admin.load.retryIn', 'Retry in {{seconds}} s', { seconds: retryAfterSeconds });
    }
    button = (
      <button
        type="button"
        onClick={handleRetry}
        aria-disabled={waiting || undefined}
        aria-busy={busy || undefined}
        className={RETRY_BUTTON_CLASS}
      >
        <Icon name="refresh" size="sm" aria-hidden="true" />
        {label}
      </button>
    );
  } else {
    button = (
      <button type="button" onClick={() => window.location.reload()} className={RETRY_BUTTON_CLASS}>
        {t('common.retry', 'Retry')}
      </button>
    );
  }

  const panel = (
    <div
      data-testid="admin-load-error"
      className={`${
        neutral
          ? 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
          : 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800'
      } border rounded-md p-4 ${className}`}
    >
      <div className="flex">
        <Icon
          name={forbidden && neutral ? 'lock-closed' : 'exclamation-triangle'}
          className={`h-5 w-5 shrink-0 ${
            neutral ? 'text-gray-500 dark:text-gray-400' : 'text-red-700 dark:text-red-400'
          }`}
          aria-hidden="true"
        />
        <div className="ml-3">
          <div role="alert">
            <h3
              className={`text-sm font-semibold ${
                neutral ? 'text-gray-900 dark:text-gray-100' : 'text-red-800 dark:text-red-200'
              }`}
            >
              {heading}
            </h3>
            {body && (
              <p
                className={`mt-1 text-sm ${
                  neutral ? 'text-gray-700 dark:text-gray-300' : 'text-red-700 dark:text-red-300'
                }`}
              >
                {body}
              </p>
            )}
          </div>
          {button}
        </div>
      </div>
    </div>
  );

  return framed ? (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">{panel}</div>
  ) : (
    panel
  );
}

export default AdminLoadError;
