// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { describeConnectionError, SSL_SETTINGS_PATH } from '../utils/connectionErrorHelp';

/**
 * The lines below the headline of a failed connection (model test, model
 * import): the facts the server sent (HTTP status, host, error code), what to
 * check, and for an untrusted certificate a link to the SSL / TLS settings.
 *
 * Renders nothing when there is nothing to say.
 *
 * @param {Object} props
 * @param {Object|null} [props.details] - The problem body's `details`
 * @param {string|null} [props.fallback] - Text when the server named no cause
 * @param {string} [props.className] - Classes for the wrapper
 * @param {string} [props.textClassName] - Classes for the remediation line
 */
function ConnectionErrorDetails({
  details,
  fallback = null,
  className = '',
  textClassName = 'text-sm text-gray-700 dark:text-gray-300'
}) {
  const { t } = useTranslation();
  const { facts, remediation, showSslSettingsLink } = describeConnectionError(t, details, fallback);
  if (!facts && !remediation && !showSslSettingsLink) return null;

  return (
    <div className={className} data-testid="connection-error-details">
      {facts && (
        <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400 break-all">{facts}</p>
      )}
      {remediation && <p className={`mt-1 ${textClassName}`}>{remediation}</p>}
      {showSslSettingsLink && (
        <Link
          to={SSL_SETTINGS_PATH}
          className="mt-1 inline-block text-sm font-medium text-indigo-700 dark:text-indigo-300 underline hover:no-underline"
        >
          {t('admin.connectionErrors.openSslSettings', 'Open the SSL / TLS settings')}
        </Link>
      )}
    </div>
  );
}

export default ConnectionErrorDetails;
