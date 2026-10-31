// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../../shared/components/Modal';
import Icon from '../../../../shared/components/Icon';
import LoadingSpinner from '../../../../shared/components/LoadingSpinner';
import { CALLOUT_CLASS, DANGER_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import {
  disconnectIntegrationUser,
  fetchIntegrationConnections,
  resetIntegrationRegistration
} from '../../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';

/**
 * The users who connected their own account to an installation that signs
 * every user in (per-user OAuth): disconnect one, or reset iHub's OAuth client
 * registration at the authorization server.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installed integration (`id`, `label`)
 * @param {() => void} props.onClose
 */
function IntegrationConnectionsDialog({ instance, onClose }) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setConnections(await fetchIntegrationConnections(instance.id));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setConnections([]);
    }
  }, [instance.id]);

  useEffect(() => {
    load();
  }, [load]);

  const disconnect = async userId => {
    if (
      !window.confirm(
        t(
          'admin.integrationCatalog.connections.disconnectConfirm',
          'Disconnect "{{user}}" from {{label}}? They have to sign in again to use it.',
          { user: userId, label: instance.label }
        )
      )
    )
      return;
    setBusy(userId);
    setMessage(null);
    try {
      await disconnectIntegrationUser(instance.id, userId);
      await load();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (
      !window.confirm(
        t(
          'admin.integrationCatalog.connections.resetConfirm',
          'Reset the OAuth client registration of {{label}}? The next sign-in registers iHub afresh; connected users may have to connect again.',
          { label: instance.label }
        )
      )
    )
      return;
    setBusy('reset');
    setMessage(null);
    try {
      await resetIntegrationRegistration(instance.id);
      setMessage(
        t('admin.integrationCatalog.connections.resetDone', 'OAuth client registration reset')
      );
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      labelledBy="integration-connections-title"
    >
      <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
        <div>
          <h2
            id="integration-connections-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.integrationCatalog.connections.title', 'Connected users')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">{instance.label}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1"
          aria-label={t('common.close', 'Close')}
        >
          <Icon name="x" size="md" />
        </button>
      </div>
      <div className="px-6 py-4 space-y-4">
        {error && (
          <div className={CALLOUT_CLASS.danger} role="alert">
            {error}
          </div>
        )}
        {message && <div className={CALLOUT_CLASS.success}>{message}</div>}
        {connections === null ? (
          <div className="flex justify-center py-6">
            <LoadingSpinner size="md" />
          </div>
        ) : connections.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.integrationCatalog.connections.empty',
              'Nobody has connected their account yet.'
            )}
          </p>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
            {connections.map(connection => (
              <li
                key={connection.userId}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {connection.userId}
                  </span>
                  {connection.createdAt && (
                    <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                      {t('admin.integrationCatalog.connections.connectedAt', 'since {{date}}', {
                        date: new Date(connection.createdAt).toLocaleString()
                      })}
                    </span>
                  )}
                  {connection.expired && (
                    <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">
                      {t('admin.integrationCatalog.connections.expired', 'expired')}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className={DANGER_BUTTON_CLASS}
                  disabled={busy === connection.userId}
                  onClick={() => disconnect(connection.userId)}
                >
                  {t('admin.integrationCatalog.connections.disconnect', 'Disconnect')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          disabled={busy === 'reset'}
          onClick={reset}
        >
          {t(
            'admin.integrationCatalog.connections.resetRegistration',
            'Reset OAuth client registration'
          )}
        </button>
        <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onClose}>
          {t('common.close', 'Close')}
        </button>
      </div>
    </Modal>
  );
}

export default IntegrationConnectionsDialog;
