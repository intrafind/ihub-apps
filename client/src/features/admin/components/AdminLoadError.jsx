// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Error panel an admin list page shows when its data could not be loaded:
 * a title, the error message and a "Retry" button that reloads the page.
 *
 * @param {object} props
 * @param {string} props.title - What failed, e.g. "Error loading tools"
 * @param {string} props.message - The error message
 * @param {boolean} [props.framed=true] - Wrap the panel in the admin page container
 * @param {function} [props.onRetry] - Called by the Retry button; reloads the page by default
 */
function AdminLoadError({
  title,
  message,
  framed = true,
  onRetry = () => window.location.reload()
}) {
  const { t } = useTranslation();

  const panel = (
    <div
      role="alert"
      className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4"
    >
      <div className="flex">
        <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
        <div className="ml-3">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200">{title}</h3>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-sm text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
          >
            {t('common.retry', 'Retry')}
          </button>
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
