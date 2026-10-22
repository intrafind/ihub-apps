// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * The error panel of the admin area: a page's data failed to load, or a save
 * failed. One look everywhere, announced to screen readers as an alert, with
 * text that meets the contrast ratio on the red panel.
 *
 * The button is "Retry" (reloads the page) unless `action` says otherwise.
 *
 * @param {object} props
 * @param {string} props.message - The error message
 * @param {string} [props.title] - What failed, e.g. "Error loading tools"; defaults to "Error"
 * @param {boolean} [props.framed=true] - Wrap the panel in the admin page container
 *   (a page that shows nothing but the error). Pass false for a banner inside a page.
 * @param {{label: string, onClick: function}|null} [props.action] - Replaces the "Retry"
 *   button, e.g. "Back to Prompts"; null shows no button
 * @param {string} [props.className] - Extra classes for the panel, e.g. a bottom margin
 */
function AdminLoadError({ message, title, framed = true, action, className = '' }) {
  const { t } = useTranslation();

  const button =
    action === null
      ? null
      : (action ?? { label: t('common.retry', 'Retry'), onClick: () => window.location.reload() });

  const panel = (
    <div
      role="alert"
      className={`bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4 ${className}`}
    >
      <div className="flex">
        <Icon name="exclamation-triangle" className="h-5 w-5 shrink-0 text-red-400" />
        <div className="ml-3">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
            {title ?? t('common.error', 'Error')}
          </h3>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{message}</p>
          {button && (
            <button
              type="button"
              onClick={button.onClick}
              className="mt-2 text-sm text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
            >
              {button.label}
            </button>
          )}
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
