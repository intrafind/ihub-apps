// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import AdminLoadGate from './AdminLoadGate';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';
import { useDirtyReport } from '../hooks/useDirtyReport';
import { CHECKBOX_CLASS } from './formStyles';
import { useSaveSection } from './SaveSections';

/**
 * @param {Object} props
 * @param {(dirty: boolean) => void} [props.onDirtyChange] - Reports unsaved edits to the page.
 */
function CookieSettingsConfig({ onDirtyChange }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState({
    disableSecure: false
  });
  // The settings as last loaded or saved; null until they loaded.
  const [savedConfig, setSavedConfig] = useState(null);
  const isDirty = useDirtyReport(savedConfig, config, onDirtyChange);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // The card shows no form and no Save until its settings loaded: saving
  // the defaults after a failed load would overwrite the stored ones (PL-B3).
  const load = useAdminConfigLoad({
    sources: {
      config: {
        load: async () =>
          (
            await makeAdminApiCall('/admin/configs/platform', {
              method: 'GET'
            })
          ).data,
        onLoad: data => {
          const loaded = {
            disableSecure: data?.cookieSettings?.disableSecure || false
          };
          setConfig(loaded);
          setSavedConfig(loaded);
        }
      }
    }
  });
  const ready = load.status === 'ready';

  const handleToggleDisableSecure = e => {
    setConfig(prev => ({
      ...prev,
      disableSecure: e.target.checked
    }));
  };

  /** Saves the section. Resolves false when it did not save, so the page's bar stops and stays. */
  const handleSaveConfig = async () => {
    if (!ready) return false;
    setSaving(true);
    setMessage('');

    try {
      // A scoped change of this one field. Not a POST: the Security page's
      // other cards save platform.json through their own routes, so the
      // revision this card loaded is stale after any of them saved, and a
      // guarded POST would report a conflict with the admin's own change.
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'PATCH',
        body: { cookieSettings: { disableSecure: config.disableSecure } }
      });
      setSavedConfig(config);

      setMessage({
        type: 'success',
        text: t('admin.system.cookieSettings.configSaved')
      });
      return true;
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.system.cookieSettings.configSaveError')
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  // The page's bar saves and discards the section.
  useSaveSection('cookies', {
    dirty: isDirty,
    saving,
    error: message?.type === 'error' ? message.text : null,
    save: handleSaveConfig,
    discard: () => {
      if (savedConfig) setConfig(savedConfig);
      setMessage('');
    }
  });

  if (!ready) {
    return (
      <AdminLoadGate
        load={load}
        resourceLabel={t('admin.system.cookieSettings.title')}
        loadingFallback={
          <div className="flex items-center justify-center py-8">
            <Icon
              name="loader"
              className="h-6 w-6 animate-spin text-admin-accent dark:text-admin-accent-fg-dark"
            />
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {t('admin.system.cookieSettings.title')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('admin.system.cookieSettings.description')}
        </p>
      </div>

      {/* Default Behavior Info */}
      <div className="rounded-md bg-blue-50 dark:bg-blue-900/20 p-4">
        <div className="flex">
          <div className="shrink-0">
            <Icon name="info" className="h-5 w-5 text-blue-400" />
          </div>
          <div className="ml-3">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t('admin.system.cookieSettings.defaultBehavior')}
            </p>
          </div>
        </div>
      </div>

      {/* Security Warning - Only show when disableSecure is enabled */}
      {config.disableSecure && (
        <div className="rounded-md bg-yellow-50 dark:bg-yellow-900/20 p-4">
          <div className="flex">
            <div className="shrink-0">
              <Icon name="alert-triangle" className="h-5 w-5 text-yellow-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                {t('admin.system.cookieSettings.securityWarning')}
              </h3>
              <div className="mt-2 text-sm text-yellow-700 dark:text-yellow-300">
                <p>{t('admin.system.cookieSettings.securityWarningDesc')}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Disable Secure Cookie Flag Toggle */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-start">
          <div className="flex h-5 items-center">
            <input
              id="disableSecure"
              name="disableSecure"
              type="checkbox"
              checked={config.disableSecure}
              onChange={handleToggleDisableSecure}
              className={CHECKBOX_CLASS}
            />
          </div>
          <div className="ml-3 text-sm">
            <label htmlFor="disableSecure" className="font-medium text-gray-900 dark:text-white">
              {t('admin.system.cookieSettings.disableSecure')}
            </label>
            <p className="text-gray-600 dark:text-gray-400">
              {t('admin.system.cookieSettings.disableSecureDesc')}
            </p>
          </div>
        </div>
      </div>

      {/* The result of the last save; the page's bar saves. */}
      {message && (
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <div
            role={message.type === 'success' ? 'status' : 'alert'}
            className={`text-sm ${
              message.type === 'success'
                ? 'text-green-700 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {message.text}
          </div>
        </div>
      )}
    </div>
  );
}

export default CookieSettingsConfig;
