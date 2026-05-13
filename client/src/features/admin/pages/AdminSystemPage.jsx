import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import SSLConfig from '../components/SSLConfig';
import CorsConfig from '../components/CorsConfig';
import CookieSettingsConfig from '../components/CookieSettingsConfig';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

function AdminSystemPage() {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const fileInputRef = useRef(null);
  const [forceRefreshLoading, setForceRefreshLoading] = useState(false);
  const [forceRefreshMessage, setForceRefreshMessage] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const [versionInfo, setVersionInfo] = useState(null);
  const [versionLoading, setVersionLoading] = useState(true);
  const [versionError, setVersionError] = useState('');
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateCheckLoading, setUpdateCheckLoading] = useState(true);
  const [encryptValue, setEncryptValue] = useState('');
  const [encryptedResult, setEncryptedResult] = useState('');
  const [encryptLoading, setEncryptLoading] = useState(false);
  const [encryptMessage, setEncryptMessage] = useState('');
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateActionLoading, setUpdateActionLoading] = useState(false);
  const [updateActionMessage, setUpdateActionMessage] = useState('');
  const [updateActionMessageType, setUpdateActionMessageType] = useState('success');
  const updatePollIntervalRef = useRef(null);
  const rollbackPollIntervalRef = useRef(null);
  // Abort prior in-flight /admin/version polls when a new tick starts (or on
  // unmount). On a slow network, 3s ticks with 30s axios timeouts could
  // otherwise stack ~10 pending requests and saturate the browser's
  // 6-connection HTTP/1.1 pool.
  const updatePollAbortRef = useRef(null);
  const rollbackPollAbortRef = useRef(null);

  // Fetch version information on mount
  useEffect(() => {
    const fetchVersionInfo = async () => {
      try {
        const response = await makeAdminApiCall('/admin/version', {
          method: 'GET'
        });
        setVersionInfo(response.data);
        setVersionError('');
      } catch (error) {
        console.error('Error fetching version info:', error);
        setVersionError(error.message || 'Failed to load version information');
      } finally {
        setVersionLoading(false);
      }
    };

    fetchVersionInfo();
  }, []);

  // Check for updates on mount
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const response = await makeAdminApiCall('/admin/version/check-update', {
          method: 'GET'
        });
        setUpdateInfo(response.data);
      } catch (error) {
        console.error('Error checking for updates:', error);
        setUpdateInfo({ updateAvailable: false, error: error.message });
      } finally {
        setUpdateCheckLoading(false);
      }
    };

    checkForUpdates();
  }, []);

  // Fetch update status (for binary installations)
  useEffect(() => {
    const fetchUpdateStatus = async () => {
      try {
        const response = await makeAdminApiCall('/admin/update/status', { method: 'GET' });
        setUpdateStatus(response.data);
      } catch {
        // Update status not available (not a binary installation or feature not supported)
      }
    };
    fetchUpdateStatus();
  }, []);

  // Clean up polling intervals (and any in-flight version-poll requests) on unmount
  useEffect(() => {
    return () => {
      if (updatePollIntervalRef.current) clearInterval(updatePollIntervalRef.current);
      if (rollbackPollIntervalRef.current) clearInterval(rollbackPollIntervalRef.current);
      if (updatePollAbortRef.current) {
        updatePollAbortRef.current.abort();
        updatePollAbortRef.current = null;
      }
      if (rollbackPollAbortRef.current) {
        rollbackPollAbortRef.current.abort();
        rollbackPollAbortRef.current = null;
      }
    };
  }, []);

  const handleUpdateNow = async () => {
    setUpdateActionLoading(true);
    setUpdateActionMessage('');
    setUpdateActionMessageType('success');

    try {
      // Step 1: Download
      setUpdateActionMessage(t('admin.system.updateDownloading', 'Downloading update...'));
      await makeAdminApiCall('/admin/update/download', { method: 'POST' });

      // Step 2: Apply
      setUpdateActionMessage(t('admin.system.updateApplying', 'Applying update...'));
      await makeAdminApiCall('/admin/update/apply', { method: 'POST' });

      // Server will restart - show message and poll for reconnection
      setUpdateActionMessage(
        t('admin.system.updateRestarting', 'Update applied. Server is restarting...')
      );

      // Poll until server comes back
      updatePollIntervalRef.current = setInterval(async () => {
        // Abort any previous tick's request still in flight — otherwise slow
        // (non-refused) failures could pile up and saturate the connection pool.
        if (updatePollAbortRef.current) {
          updatePollAbortRef.current.abort();
        }
        const controller = new AbortController();
        updatePollAbortRef.current = controller;
        try {
          const response = await makeAdminApiCall('/admin/version', {
            method: 'GET',
            signal: controller.signal
          });
          if (response.data) {
            clearInterval(updatePollIntervalRef.current);
            updatePollIntervalRef.current = null;
            updatePollAbortRef.current = null;
            setUpdateActionMessage(
              t('admin.system.updateSuccess', 'Update complete! Now running version {{version}}.', {
                version: response.data.app
              })
            );
            setUpdateActionMessageType('success');
            setUpdateActionLoading(false);
            setVersionInfo(response.data);
            setUpdateInfo(prev => (prev ? { ...prev, updateAvailable: false } : prev));
            // Refresh update status
            try {
              const statusRes = await makeAdminApiCall('/admin/update/status', { method: 'GET' });
              setUpdateStatus(statusRes.data);
            } catch {
              // ignore
            }
          }
        } catch {
          // Server not ready yet (or our own abort), keep polling
        } finally {
          if (updatePollAbortRef.current === controller) {
            updatePollAbortRef.current = null;
          }
        }
      }, 3000);

      // Stop polling after 2 minutes and show timeout error
      setTimeout(() => {
        if (updatePollIntervalRef.current) {
          clearInterval(updatePollIntervalRef.current);
          updatePollIntervalRef.current = null;
          setUpdateActionMessage(
            t(
              'admin.system.updateTimeout',
              'Update is taking longer than expected. Please check the server status and try again.'
            )
          );
          setUpdateActionMessageType('error');
          setUpdateActionLoading(false);
        }
      }, 120000);
    } catch (error) {
      setUpdateActionMessage(
        t('admin.system.updateFailed', 'Update failed: {{error}}', {
          error: error.response?.data?.error || error.message
        })
      );
      setUpdateActionMessageType('error');
      setUpdateActionLoading(false);
    }
  };

  const handleRollback = async () => {
    if (
      !window.confirm(
        t(
          'admin.system.rollbackConfirm',
          'Are you sure you want to rollback to the previous version?'
        )
      )
    ) {
      return;
    }

    setUpdateActionLoading(true);
    setUpdateActionMessage(t('admin.system.rollbackApplying', 'Rolling back...'));
    setUpdateActionMessageType('success');

    try {
      await makeAdminApiCall('/admin/update/rollback', { method: 'POST' });

      setUpdateActionMessage(
        t('admin.system.rollbackRestarting', 'Rollback applied. Server is restarting...')
      );

      // Poll until server comes back
      rollbackPollIntervalRef.current = setInterval(async () => {
        if (rollbackPollAbortRef.current) {
          rollbackPollAbortRef.current.abort();
        }
        const controller = new AbortController();
        rollbackPollAbortRef.current = controller;
        try {
          const response = await makeAdminApiCall('/admin/version', {
            method: 'GET',
            signal: controller.signal
          });
          if (response.data) {
            clearInterval(rollbackPollIntervalRef.current);
            rollbackPollIntervalRef.current = null;
            rollbackPollAbortRef.current = null;
            setUpdateActionMessage(
              t(
                'admin.system.rollbackSuccess',
                'Rollback complete! Now running version {{version}}.',
                {
                  version: response.data.app
                }
              )
            );
            setUpdateActionMessageType('success');
            setUpdateActionLoading(false);
            setVersionInfo(response.data);
            try {
              const statusRes = await makeAdminApiCall('/admin/update/status', { method: 'GET' });
              setUpdateStatus(statusRes.data);
            } catch {
              // ignore
            }
          }
        } catch {
          // Server not ready yet (or our own abort)
        } finally {
          if (rollbackPollAbortRef.current === controller) {
            rollbackPollAbortRef.current = null;
          }
        }
      }, 3000);

      setTimeout(() => {
        if (rollbackPollIntervalRef.current) {
          clearInterval(rollbackPollIntervalRef.current);
          rollbackPollIntervalRef.current = null;
          setUpdateActionMessage(
            t(
              'admin.system.rollbackTimeout',
              'Rollback is taking longer than expected. Please check the server status and logs.'
            )
          );
          setUpdateActionMessageType('error');
          setUpdateActionLoading(false);
        }
      }, 120000);
    } catch (error) {
      setUpdateActionMessage(
        t('admin.system.rollbackFailed', 'Rollback failed: {{error}}', {
          error: error.response?.data?.error || error.message
        })
      );
      setUpdateActionMessageType('error');
      setUpdateActionLoading(false);
    }
  };

  const handleForceRefresh = async () => {
    setForceRefreshLoading(true);
    setForceRefreshMessage('');

    try {
      const response = await makeAdminApiCall('/admin/client/_refresh', {
        method: 'POST'
      });

      const data = response.data;

      setForceRefreshMessage({
        type: 'success',
        text: t(
          'admin.system.triggerSuccess',
          'Force refresh triggered successfully! New salt: {{salt}}. All clients will refresh on their next page load.',
          { salt: data.newAdminSalt }
        )
      });
    } catch (error) {
      setForceRefreshMessage({
        type: 'error',
        text:
          t('admin.system.triggerError', 'Failed to trigger force refresh') +
          (error.message ? `: ${error.message}` : '')
      });
    } finally {
      setForceRefreshLoading(false);
    }
  };

  const handleExportConfig = async () => {
    setExportLoading(true);

    try {
      const response = await makeAdminApiCall('/admin/backup/export', {
        method: 'GET',
        responseType: 'blob'
      });

      // Success - axios doesn't have response.ok, successful responses are returned directly

      // Create download link for the ZIP file
      const blob = response.data;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');

      // Extract filename from Content-Disposition header or create default
      const contentDisposition = response.headers['content-disposition'];
      const filenameMatch = contentDisposition && contentDisposition.match(/filename="(.+)"/);
      const filename = filenameMatch
        ? filenameMatch[1]
        : `ihub-config-backup-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.zip`;

      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Export error:', error);
      setImportMessage({
        type: 'error',
        text: t('admin.system.exportError', 'Failed to export configuration: {{error}}', {
          error: error.message
        })
      });
    } finally {
      setExportLoading(false);
    }
  };

  const handleImportConfig = async event => {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.zip')) {
      setImportMessage({
        type: 'error',
        text: t('admin.system.importInvalidFile', 'Please select a ZIP file')
      });
      return;
    }

    if (
      !window.confirm(
        t(
          'admin.system.importConfirm',
          'Are you sure you want to import this configuration? This will replace ALL existing configurations, apps, models, and custom pages. A backup of the current configuration will be created automatically.'
        )
      )
    ) {
      return;
    }

    setImportLoading(true);
    setImportMessage('');

    try {
      const formData = new FormData();
      formData.append('backup', file);

      const response = await makeAdminApiCall('/admin/backup/import', {
        method: 'POST',
        body: formData
      });

      const data = response.data;

      // Success - axios doesn't have response.ok, successful responses are returned directly

      setImportMessage({
        type: 'success',
        text: t(
          'admin.system.importSuccess',
          'Configuration imported successfully! {{fileCount}} files imported. Current configuration backed up as: {{backup}}',
          {
            fileCount: data.importedFiles,
            backup: data.backupPath
          }
        )
      });

      // Clear file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      console.error('Import error:', error);
      setImportMessage({
        type: 'error',
        text: t('admin.system.importError', 'Failed to import configuration: {{error}}', {
          error: error.message
        })
      });
    } finally {
      setImportLoading(false);
    }
  };

  const handleEncryptValue = async () => {
    // Validate input
    if (!encryptValue || encryptValue.trim() === '') {
      setEncryptMessage({
        type: 'error',
        text: t('admin.system.encryptEmptyError', 'Please enter a value to encrypt')
      });
      return;
    }

    setEncryptLoading(true);
    setEncryptMessage('');
    setEncryptedResult('');

    try {
      const response = await makeAdminApiCall('/admin/encrypt-value', {
        method: 'POST',
        body: JSON.stringify({ value: encryptValue }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;

      setEncryptedResult(data.encryptedValue);
      setEncryptMessage({
        type: 'success',
        text: t('admin.system.encryptSuccess', 'Value encrypted successfully')
      });
    } catch (error) {
      console.error('Encrypt error:', error);
      setEncryptMessage({
        type: 'error',
        text: t('admin.system.encryptError', 'Failed to encrypt value: {{error}}', {
          error: error.message
        })
      });
    } finally {
      setEncryptLoading(false);
    }
  };

  const handleCopyEncrypted = async () => {
    if (!encryptedResult) return;

    try {
      await navigator.clipboard.writeText(encryptedResult);
      setEncryptMessage({
        type: 'success',
        text: t('admin.system.copiedToClipboard', 'Copied to clipboard!')
      });
    } catch (error) {
      setEncryptMessage({
        type: 'error',
        text: t('admin.system.copyError', 'Failed to copy to clipboard')
      });
    }
  };

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                  {t('admin.system.title', 'System Administration')}
                </h1>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  {t('admin.system.description', 'Manage system-wide settings and maintenance')}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="space-y-8">
            {/* Force Refresh Section */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
              <div className="flex items-start space-x-4">
                <div className="flex-shrink-0 mt-1">
                  <div className="p-3 rounded-full bg-orange-100 dark:bg-orange-900/50">
                    <Icon
                      name="refresh"
                      size="lg"
                      className="text-orange-600 dark:text-orange-400"
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                    {t('admin.system.forceTitle', 'Force Client Refresh')}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-400 mb-4">
                    {t(
                      'admin.system.forceDesc',
                      'Trigger a force refresh for all clients. This will clear all browser caches, localStorage, and force clients to reload all assets (JS, CSS, fonts, configurations) without using browser cache. The disclaimer acceptance will be preserved.'
                    )}
                  </p>

                  <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-4 mb-4">
                    <div className="flex">
                      <Icon name="warning" size="md" className="text-amber-500 mt-0.5 mr-3" />
                      <div>
                        <h4 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                          {t('admin.system.warningTitle', 'Warning')}
                        </h4>
                        <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                          {t(
                            'admin.system.warningDesc',
                            'This action will force all connected clients to reload their browsers on their next page interaction. Use this when deploying critical updates or when clients need to clear cached data.'
                          )}
                        </p>
                      </div>
                    </div>
                  </div>

                  {forceRefreshMessage && (
                    <div
                      className={`p-4 rounded-md mb-4 ${
                        forceRefreshMessage.type === 'success'
                          ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                          : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
                      }`}
                    >
                      <div className="flex">
                        <Icon
                          name={forceRefreshMessage.type === 'success' ? 'check' : 'warning'}
                          size="md"
                          className={`mt-0.5 mr-3 ${
                            forceRefreshMessage.type === 'success'
                              ? 'text-green-500'
                              : 'text-red-500'
                          }`}
                        />
                        <p
                          className={`text-sm ${
                            forceRefreshMessage.type === 'success'
                              ? 'text-green-700 dark:text-green-300'
                              : 'text-red-700 dark:text-red-300'
                          }`}
                        >
                          {forceRefreshMessage.text}
                        </p>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleForceRefresh}
                    disabled={forceRefreshLoading}
                    className={`
                    inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium 
                    rounded-md shadow-sm text-white 
                    ${
                      forceRefreshLoading
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500'
                    }
                  `}
                  >
                    {forceRefreshLoading ? (
                      <>
                        <svg
                          className="animate-spin -ml-1 mr-3 h-4 w-4 text-white"
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          ></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          ></path>
                        </svg>
                        {t('admin.system.triggering', 'Triggering Force Refresh...')}
                      </>
                    ) : (
                      <>
                        <Icon name="refresh" size="md" className="mr-2" />
                        {t('admin.system.trigger', 'Trigger Force Refresh')}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Value Encryption Tool Section */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
              <div className="flex items-start space-x-4">
                <div className="flex-shrink-0 mt-1">
                  <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/50">
                    <Icon
                      name="shield-check"
                      size="lg"
                      className="text-blue-600 dark:text-blue-400"
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                    {t('admin.system.encryptTitle', 'Value Encryption Tool')}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-400 mb-4">
                    {t(
                      'admin.system.encryptDesc',
                      'Encrypt sensitive values (passwords, API keys, secrets) to store them securely in .env files or configuration. The encrypted values will be automatically decrypted when loaded by the application.'
                    )}
                  </p>

                  <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-4 mb-4">
                    <div className="flex">
                      <Icon
                        name="information-circle"
                        size="md"
                        className="text-amber-500 mt-0.5 mr-3"
                      />
                      <div>
                        <h4 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                          {t('admin.system.encryptInfoTitle', 'Usage Instructions')}
                        </h4>
                        <ul className="text-sm text-amber-700 dark:text-amber-300 mt-1 space-y-1">
                          <li>
                            {t(
                              'admin.system.encryptInfo1',
                              '1. Enter your plaintext value (password, API key, etc.)'
                            )}
                          </li>
                          <li>
                            {t(
                              'admin.system.encryptInfo2',
                              '2. Click "Encrypt Value" to generate an encrypted version'
                            )}
                          </li>
                          <li>
                            {t(
                              'admin.system.encryptInfo3',
                              '3. Copy the encrypted value (starts with ENC[...])'
                            )}
                          </li>
                          <li>
                            {t(
                              'admin.system.encryptInfo4',
                              '4. Store it in your .env file or configuration'
                            )}
                          </li>
                          <li>
                            {t(
                              'admin.system.encryptInfo5',
                              '5. The application will automatically decrypt it at runtime'
                            )}
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  {encryptMessage && (
                    <div
                      className={`p-4 rounded-md mb-4 ${
                        encryptMessage.type === 'success'
                          ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                          : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
                      }`}
                    >
                      <div className="flex">
                        <Icon
                          name={encryptMessage.type === 'success' ? 'check' : 'warning'}
                          size="md"
                          className={`mt-0.5 mr-3 ${
                            encryptMessage.type === 'success' ? 'text-green-500' : 'text-red-500'
                          }`}
                        />
                        <p
                          className={`text-sm ${
                            encryptMessage.type === 'success'
                              ? 'text-green-700 dark:text-green-300'
                              : 'text-red-700 dark:text-red-300'
                          }`}
                        >
                          {encryptMessage.text}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="space-y-4">
                    <div>
                      <label
                        htmlFor="encryptValue"
                        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
                      >
                        {t('admin.system.encryptInputLabel', 'Plaintext Value to Encrypt')}
                      </label>
                      <input
                        type="password"
                        id="encryptValue"
                        value={encryptValue}
                        onChange={e => setEncryptValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !encryptLoading) {
                            handleEncryptValue();
                          }
                        }}
                        className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                        placeholder={t(
                          'admin.system.encryptInputPlaceholder',
                          'Enter value to encrypt (password, API key, etc.)'
                        )}
                        disabled={encryptLoading}
                      />
                    </div>

                    <button
                      onClick={handleEncryptValue}
                      disabled={encryptLoading || !encryptValue}
                      className={`
                        inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium 
                        rounded-md shadow-sm text-white 
                        ${
                          encryptLoading || !encryptValue
                            ? 'bg-gray-400 cursor-not-allowed'
                            : 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
                        }
                      `}
                    >
                      {encryptLoading ? (
                        <>
                          <svg
                            className="animate-spin -ml-1 mr-3 h-4 w-4 text-white"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            ></circle>
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            ></path>
                          </svg>
                          {t('admin.system.encrypting', 'Encrypting...')}
                        </>
                      ) : (
                        <>
                          <Icon name="shield-check" size="md" className="mr-2" />
                          {t('admin.system.encryptButton', 'Encrypt Value')}
                        </>
                      )}
                    </button>

                    {encryptedResult && (
                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                          {t('admin.system.encryptedValueLabel', 'Encrypted Value')}
                        </label>
                        <div className="relative">
                          <textarea
                            readOnly
                            value={encryptedResult}
                            className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-xs sm:text-sm"
                            rows={4}
                            onClick={e => e.target.select()}
                          />
                          <button
                            onClick={handleCopyEncrypted}
                            className="absolute top-2 right-2 inline-flex items-center px-3 py-1 border border-gray-300 dark:border-gray-600 shadow-sm text-xs font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 hover:bg-gray-50 dark:hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                          >
                            <Icon name="clipboard" size="sm" className="mr-1" />
                            {t('admin.system.copyButton', 'Copy')}
                          </button>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {t(
                            'admin.system.encryptedValueHint',
                            'Use this encrypted value in your .env file or configuration. It will be automatically decrypted at runtime.'
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Backup/Import Section */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
              <div className="flex items-start space-x-4">
                <div className="flex-shrink-0 mt-1">
                  <div className="p-3 rounded-full bg-green-100 dark:bg-green-900/50">
                    <Icon
                      name="archive-box"
                      size="lg"
                      className="text-green-600 dark:text-green-400"
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                    {t('admin.system.backupTitle', 'Configuration Backup & Import')}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-400 mb-4">
                    {t(
                      'admin.system.backupDesc',
                      'Export your complete configuration as a ZIP file for disaster recovery, or import a configuration backup to restore your system. This includes all apps, models, groups, custom pages, and frontend customizations (CSS, HTML, etc.).'
                    )}
                  </p>

                  <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-md p-4 mb-4">
                    <div className="flex">
                      <Icon
                        name="information-circle"
                        size="md"
                        className="text-blue-500 mt-0.5 mr-3"
                      />
                      <div>
                        <h4 className="text-sm font-medium text-blue-800 dark:text-blue-200">
                          {t('admin.system.backupInfoTitle', "What's included in backups")}
                        </h4>
                        <ul className="text-sm text-blue-700 dark:text-blue-300 mt-1 list-disc list-inside space-y-1">
                          <li>
                            {t(
                              'admin.system.backupInfo1',
                              'All configuration files (platform, apps, models, groups, UI)'
                            )}
                          </li>
                          <li>
                            {t('admin.system.backupInfo2', 'Custom pages and React components')}
                          </li>
                          <li>
                            {t(
                              'admin.system.backupInfo3',
                              'Prompt templates and localization files'
                            )}
                          </li>
                          <li>
                            {t(
                              'admin.system.backupInfo4',
                              'Frontend customizations (CSS, HTML, images)'
                            )}
                          </li>
                          <li>{t('admin.system.backupInfo5', 'All data and source files')}</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  {importMessage && (
                    <div
                      className={`p-4 rounded-md mb-4 ${
                        importMessage.type === 'success'
                          ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                          : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
                      }`}
                    >
                      <div className="flex">
                        <Icon
                          name={importMessage.type === 'success' ? 'check' : 'warning'}
                          size="md"
                          className={`mt-0.5 mr-3 ${
                            importMessage.type === 'success' ? 'text-green-500' : 'text-red-500'
                          }`}
                        />
                        <p
                          className={`text-sm ${
                            importMessage.type === 'success'
                              ? 'text-green-700 dark:text-green-300'
                              : 'text-red-700 dark:text-red-300'
                          }`}
                        >
                          {importMessage.text}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-4">
                    {/* Export Button */}
                    <button
                      onClick={handleExportConfig}
                      disabled={exportLoading}
                      className={`
                        inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium 
                        rounded-md shadow-sm text-white 
                        ${
                          exportLoading
                            ? 'bg-gray-400 cursor-not-allowed'
                            : 'bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500'
                        }
                      `}
                    >
                      {exportLoading ? (
                        <>
                          <svg
                            className="animate-spin -ml-1 mr-3 h-4 w-4 text-white"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            ></circle>
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            ></path>
                          </svg>
                          {t('admin.system.exporting', 'Creating Backup...')}
                        </>
                      ) : (
                        <>
                          <Icon name="download" size="md" className="mr-2" />
                          {t('admin.system.exportConfig', 'Export Configuration')}
                        </>
                      )}
                    </button>

                    {/* Import Button */}
                    <div className="relative">
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleImportConfig}
                        accept=".zip"
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        disabled={importLoading}
                      />
                      <button
                        disabled={importLoading}
                        className={`
                          inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium 
                          rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 
                          ${
                            importLoading
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500'
                          }
                        `}
                      >
                        {importLoading ? (
                          <>
                            <svg
                              className="animate-spin -ml-1 mr-3 h-4 w-4 text-gray-700"
                              xmlns="http://www.w3.org/2000/svg"
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              ></circle>
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              ></path>
                            </svg>
                            {t('admin.system.importing', 'Importing Configuration...')}
                          </>
                        ) : (
                          <>
                            <Icon name="upload" size="md" className="mr-2" />
                            {t('admin.system.importConfig', 'Import Configuration')}
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                    <p>
                      {t(
                        'admin.system.backupNote',
                        'Note: Imports will automatically create a backup of your current configuration before replacing it.'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Version Information Section */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
              <div className="flex items-start space-x-4">
                <div className="flex-shrink-0 mt-1">
                  <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/50">
                    <Icon
                      name="information-circle"
                      size="lg"
                      className="text-blue-600 dark:text-blue-400"
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                    {t('admin.system.versionTitle', 'Version Information')}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-400 mb-4">
                    {t(
                      'admin.system.versionDesc',
                      'Current version information for the application, frontend, and backend components.'
                    )}
                  </p>

                  {/* Update Available Banner */}
                  {!updateCheckLoading &&
                    updateInfo &&
                    updateInfo.updateAvailable &&
                    !updateInfo.error && (
                      <div className="mb-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-md p-4">
                        <div className="flex items-start">
                          <div className="flex-shrink-0">
                            <Icon name="check-circle" size="md" className="text-green-500 mt-0.5" />
                          </div>
                          <div className="ml-3 flex-1">
                            <h4 className="text-sm font-medium text-green-800 dark:text-green-200">
                              {t('admin.system.updateCheckTitle', 'Update Available')}
                            </h4>
                            <div className="mt-2 text-sm text-green-700 dark:text-green-300">
                              <p>
                                {t(
                                  'admin.system.updateAvailable',
                                  'A new version of iHub Apps is available!'
                                )}
                              </p>
                              <div className="mt-2 flex items-center space-x-4">
                                <span>
                                  <strong>
                                    {t('admin.system.currentVersion', 'Current Version')}:
                                  </strong>{' '}
                                  {updateInfo.currentVersion}
                                </span>
                                <span>
                                  <strong>
                                    {t('admin.system.latestVersion', 'Latest Version')}:
                                  </strong>{' '}
                                  {updateInfo.latestVersion}
                                </span>
                              </div>
                            </div>
                            {updateStatus?.isContainer && (
                              <div className="mt-3 text-sm text-green-700 dark:text-green-300">
                                <Icon
                                  name="information-circle"
                                  size="sm"
                                  className="inline-block mr-1 -mt-0.5"
                                />
                                {t(
                                  'admin.system.updateContainerNotice',
                                  'In-place updates are disabled when running in a container. Pull a new container image and restart the container to update.'
                                )}
                              </div>
                            )}
                            <div className="mt-3 flex items-center space-x-3">
                              {updateStatus?.isBinary && !updateStatus?.isContainer && (
                                <button
                                  onClick={handleUpdateNow}
                                  disabled={updateActionLoading}
                                  className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {updateActionLoading ? (
                                    <svg
                                      className="animate-spin -ml-0.5 mr-1.5 h-3 w-3"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                    >
                                      <circle
                                        className="opacity-25"
                                        cx="12"
                                        cy="12"
                                        r="10"
                                        stroke="currentColor"
                                        strokeWidth="4"
                                      />
                                      <path
                                        className="opacity-75"
                                        fill="currentColor"
                                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                      />
                                    </svg>
                                  ) : (
                                    <Icon name="download" size="sm" className="mr-1.5" />
                                  )}
                                  {t('admin.system.updateNow', 'Update Now')}
                                </button>
                              )}
                              <a
                                href={updateInfo.releaseUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-green-700 dark:text-green-200 bg-green-100 dark:bg-green-800/50 hover:bg-green-200 dark:hover:bg-green-700/50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                              >
                                <Icon name="external-link" size="sm" className="mr-1.5" />
                                {t('admin.system.viewRelease', 'View Release on GitHub')}
                              </a>
                            </div>
                            {updateActionMessage && (
                              <div
                                className={`mt-2 text-sm ${
                                  updateActionMessageType === 'error'
                                    ? 'text-red-700 dark:text-red-300'
                                    : 'text-green-700 dark:text-green-300'
                                }`}
                              >
                                {updateActionMessage}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                  {/* Rollback Banner */}
                  {updateStatus?.hasBackup &&
                    !updateStatus?.isContainer &&
                    !updateActionLoading && (
                      <div className="mb-4 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-4">
                        <div className="flex items-start">
                          <div className="flex-shrink-0">
                            <Icon name="warning" size="md" className="text-yellow-500 mt-0.5" />
                          </div>
                          <div className="ml-3 flex-1">
                            <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                              {t('admin.system.rollbackAvailable', 'Rollback Available')}
                            </h4>
                            <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
                              {t(
                                'admin.system.rollbackDesc',
                                'A backup of version {{version}} is available. You can rollback if the current version has issues.',
                                { version: updateStatus.backupVersion || 'unknown' }
                              )}
                            </p>
                            <div className="mt-2">
                              <button
                                onClick={handleRollback}
                                className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-yellow-700 dark:text-yellow-200 bg-yellow-100 dark:bg-yellow-800/50 hover:bg-yellow-200 dark:hover:bg-yellow-700/50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500"
                              >
                                <Icon name="refresh" size="sm" className="mr-1.5" />
                                {t('admin.system.rollbackButton', 'Rollback to {{version}}', {
                                  version: updateStatus.backupVersion || 'previous'
                                })}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                  {versionLoading ? (
                    <div className="flex items-center text-gray-600 dark:text-gray-400">
                      <svg
                        className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-600"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        ></circle>
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                      </svg>
                      {t('admin.system.versionLoading', 'Loading version information...')}
                    </div>
                  ) : versionError ? (
                    <div className="p-4 rounded-md bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800">
                      <div className="flex">
                        <Icon name="warning" size="md" className="text-red-500 mt-0.5 mr-3" />
                        <p className="text-sm text-red-700 dark:text-red-300">
                          {t('admin.system.versionError', 'Failed to load version information')}:{' '}
                          {versionError}
                        </p>
                      </div>
                    </div>
                  ) : versionInfo ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            {t('admin.system.versionApp', 'Application Version')}
                          </span>
                          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {versionInfo.app}
                          </span>
                        </div>
                      </div>
                      <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            {t('admin.system.versionClient', 'Frontend Version')}
                          </span>
                          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {versionInfo.client}
                          </span>
                        </div>
                      </div>
                      <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            {t('admin.system.versionServer', 'Backend Version')}
                          </span>
                          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {versionInfo.server}
                          </span>
                        </div>
                      </div>
                      <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4 border border-gray-200 dark:border-gray-600">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            {t('admin.system.versionNode', 'Node.js Version')}
                          </span>
                          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {versionInfo.node}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {/* SSL Configuration Section */}
            <SSLConfig />

            {/* Cookie Settings Configuration Section */}
            <CookieSettingsConfig />

            {/* CORS Configuration Section */}
            <CorsConfig />
          </div>
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminSystemPage;
