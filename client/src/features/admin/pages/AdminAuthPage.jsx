// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import PlatformFormEditor from '../components/PlatformFormEditor';
import AdminLoadGate from '../components/AdminLoadGate';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getSchemaByType } from '../../../utils/schemaService';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';

/** A value with its object keys sorted, so key order does not count as a change. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map(key => [key, canonical(value[key])])
  );
}

/** Whether two configurations hold the same settings. */
function sameSettings(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Admin → Authentication: the sign-in methods of `platform.json`.
 *
 * The form shows only what the server returned. If the platform configuration
 * cannot be loaded, the page shows the load error with Retry and no form and
 * no Save: the server replaces each auth block wholesale, so saving built-in
 * defaults could turn local sign-in off and lock the admin out (ID-B1). The
 * group list and the JSON schema are optional; without them the group picker
 * and the JSON view have less help, but the page still works.
 */
function AdminAuthPage() {
  const { t } = useTranslation();
  const { refreshConfig } = usePlatformConfig();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // The configuration as last loaded or saved (the unsaved-changes baseline),
  // and the one being edited. Both stay null until the load succeeded.
  const [savedConfig, setSavedConfig] = useState(null);
  const [config, setConfig] = useState(null);

  const load = useAdminConfigLoad({
    sources: {
      platform: {
        load: async () => (await makeAdminApiCall('/admin/configs/platform')).data,
        onLoad: data => {
          setSavedConfig(data);
          setConfig(data);
        }
      },
      groups: {
        required: false,
        load: async () => {
          const response = await makeAdminApiCall('/admin/groups');
          return Object.values(response.data?.groups || {});
        }
      },
      schema: { required: false, load: () => getSchemaByType('platform') }
    }
  });
  const ready = load.status === 'ready';

  const { blocker } = useUnsavedChanges(savedConfig, config);

  const handleSave = async () => {
    // Never save what was not loaded: the form is not shown then, and a stale
    // button must not send defaults either.
    if (!ready || !config) return;
    const data = config;

    setSaving(true);
    setMessage('');

    try {
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: data
      });

      // The saved data is the new baseline. No markSaved(): an edit made while
      // the request ran must still count as unsaved.
      setSavedConfig(data);
      setMessage({
        type: 'success',
        text: t('admin.auth.saved', 'Authentication configuration saved.')
      });
      // Refresh the platform config context to update navigation
      refreshConfig();
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('admin.auth.saveFailed', 'Failed to save configuration: {{error}}', {
          error: getAdminApiErrorMessage(error)
        })
      });
    } finally {
      setSaving(false);
    }
  };

  // "Use for people search" leaves this page: offer it only for providers
  // that are saved, and only while nothing here is unsaved.
  const savedLdapProviderNames = (savedConfig?.ldapAuth?.providers || [])
    .map(provider => provider?.name)
    .filter(Boolean);
  const hasUnsavedChanges = savedConfig !== null && !sameSettings(config, savedConfig);

  const title = t('admin.auth.configuration', 'Authentication Configuration');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 shadow-xs border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.auth.subtitle',
                  'Configure multiple authentication methods and user access settings. Enable dual authentication for maximum flexibility.'
                )}
              </p>
            </div>
            {ready && (
              <button
                type="button"
                onClick={() => {
                  const dataStr = JSON.stringify(config, null, 2);
                  const dataUri =
                    'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                  const exportFileDefaultName = `platform-config.json`;
                  const linkElement = document.createElement('a');
                  linkElement.setAttribute('href', dataUri);
                  linkElement.setAttribute('download', exportFileDefaultName);
                  linkElement.click();
                }}
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="download" className="h-4 w-4 mr-2" />
                {t('common.download')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminLoadGate
          load={load}
          resourceLabel={t('admin.auth.resource', 'authentication settings')}
        >
          {() => (
            <>
              {message && (
                <div
                  role={message.type === 'error' ? 'alert' : 'status'}
                  className={`mb-6 p-4 rounded-md ${
                    message.type === 'success'
                      ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                      : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
                  }`}
                >
                  <div className="flex">
                    <Icon
                      name={message.type === 'success' ? 'check' : 'warning'}
                      size="md"
                      className={`mt-0.5 mr-3 ${
                        message.type === 'success' ? 'text-green-500' : 'text-red-700'
                      }`}
                    />
                    <p
                      className={`text-sm ${
                        message.type === 'success'
                          ? 'text-green-700 dark:text-green-300'
                          : 'text-red-700 dark:text-red-300'
                      }`}
                    >
                      {message.text}
                    </p>
                  </div>
                </div>
              )}

              <DualModeEditor
                value={config}
                onChange={setConfig}
                formComponent={PlatformFormEditor}
                formProps={{
                  availableGroups: load.data.groups || [],
                  savedLdapProviderNames,
                  hasUnsavedChanges
                }}
                jsonSchema={load.data.schema || null}
                title={title}
              />

              {/* Save buttons */}
              <div className="flex justify-end space-x-4 mt-8">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 border border-transparent rounded-md shadow-xs text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
                      {t('admin.auth.saving', 'Saving...')}
                    </>
                  ) : (
                    t('admin.auth.save', 'Save Configuration')
                  )}
                </button>
              </div>
            </>
          )}
        </AdminLoadGate>
      </div>

      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title={t('admin.unsavedChanges.title', 'Unsaved changes')}
        message={t('admin.unsavedChanges.message', 'You have unsaved changes. Leave anyway?')}
        confirmLabel={t('admin.unsavedChanges.leave', 'Leave')}
        denyLabel={t('admin.unsavedChanges.stay', 'Stay')}
        danger={false}
        onConfirm={blocker.proceed}
        onDeny={blocker.reset}
      />
    </div>
  );
}

export default AdminAuthPage;
