// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

/**
 * A polite, dismissible success line for the result of an admin action
 * ("Skill "pdf-tools" deleted."). Replaces `alert()` for success messages:
 * it does not block the page, and screen readers announce it through
 * `role="status"`.
 *
 * The live region stays mounted (empty) so the announcement is not lost when
 * the message first appears.
 *
 * @param {Object} props
 * @param {string} [props.message] - The message; nothing is shown while empty.
 * @param {() => void} [props.onDismiss] - Shows a Dismiss button when given.
 * @param {string} [props.className] - Extra classes for the wrapper.
 * @returns {JSX.Element}
 */
function AdminStatusNotice({ message, onDismiss, className = '' }) {
  const { t } = useTranslation();
  return (
    <div role="status" className={className}>
      {message ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 p-3 text-sm text-green-800 dark:text-green-200">
          <span>{message}</span>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="shrink-0 rounded-sm text-sm font-medium underline hover:no-underline focus:outline-hidden focus:ring-2 focus:ring-green-600"
            >
              {t('common.dismiss', 'Dismiss')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default AdminStatusNotice;
