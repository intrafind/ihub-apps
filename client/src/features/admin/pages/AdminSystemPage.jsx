import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

const AdminSystemPage = () => {
  const { t } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const fileInputRef = useRef(null);
  const [forceRefreshLoading, setForceRefreshLoading] = useState(false);
  const [forceRefreshMessage, setForceRefreshMessage] = useState('');
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [passwordChangeMessage, setPasswordChangeMessage] = useState('');
  const [passwordForm, setPasswordForm] = useState({
    newPassword: '',
    confirmPassword: ''
  });
  const [exportLoading, setExportLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importMessage, setImportMessage] = useState('');

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

  // Check if password change should be available (only when anonymous is the ONLY auth method)
  const shouldShowPasswordChange =
    platformConfig?.anonymousAuth?.enabled &&
    !platformConfig?.admin?.encrypted &&
    !platformConfig?.localAuth?.enabled &&
    !platformConfig?.proxyAuth?.enabled &&
    platformConfig?.auth?.mode !== 'oidc';

  const handlePasswordChange = async e => {
    e.preventDefault();

    // Validate passwords
    if (!passwordForm.newPassword || !passwordForm.confirmPassword) {
      setPasswordChangeMessage({
        type: 'error',
        text: t('admin.system.passwordError', 'Both password fields are required')
      });
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordChangeMessage({
        type: 'error',
        text: t('admin.system.passwordMismatch', 'Passwords do not match')
      });
      return;
    }

    if (passwordForm.newPassword.length < 3) {
      setPasswordChangeMessage({
        type: 'error',
        text: t('admin.system.passwordTooShort', 'Password must be at least 3 characters long')
      });
      return;
    }

    setPasswordChangeLoading(true);
    setPasswordChangeMessage('');

    try {
      await makeAdminApiCall('/admin/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          newPassword: passwordForm.newPassword
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      setPasswordChangeMessage({
        type: 'success',
        text: t('admin.system.passwordChanged', 'Admin password changed successfully and encrypted')
      });

      // Clear form
      setPasswordForm({
        newPassword: '',
        confirmPassword: ''
      });
    } catch (error) {
      setPasswordChangeMessage({
        type: 'error',
        text:
          t('admin.system.passwordChangeError', 'Failed to change password') +
          (error.message ? `: ${error.message}` : '')
      });
    } finally {
      setPasswordChangeLoading(false);
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

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">
                  {t('admin.system.title', 'System Administration')}
                </h1>
                <p className="text-gray-600 mt-1">
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
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-start space-x-4">
                <div className="flex-shrink-0 mt-1">
                  <div className="p-3 rounded-full bg-orange-100">
                    <Icon name="refresh" size="lg" className="text-orange-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    {t('admin.system.forceTitle', 'Force Client Refresh')}
                  </h3>
                  <p className="text-gray-600 mb-4">
                    {t(
                      'admin.system.forceDesc',
                      'Trigger a force refresh for all clients. This will clear all browser caches, localStorage, and force clients to reload all assets (JS, CSS, fonts, configurations) without using browser cache. The disclaimer acceptance will be preserved.'
                    )}
                  </p>

                  <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-4">
                    <div className="flex">
                      <Icon name="warning" size="md" className="text-amber-500 mt-0.5 mr-3" />
                      <div>
                        <h4 className="text-sm font-medium text-amber-800">
                          {t('admin.system.warningTitle', 'Warning')}
                        </h4>
                        <p className="text-sm text-amber-700 mt-1">
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
                          ? 'bg-green-50 border border-green-200'
                          : 'bg-red-50 border border-red-200'
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
                              ? 'text-green-700'
                              : 'text-red-700'
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

            {/* Password Change Section - Only show for anonymous mode */}
            {shouldShowPasswordChange && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-start space-x-4">
                  <div className="flex-shrink-0 mt-1">
                    <div className="p-3 rounded-full bg-purple-100">
                      <Icon name="lock" size="lg" className="text-purple-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">
                      {t('admin.system.passwordTitle', 'Change Admin Password')}
                    </h3>
                    <p className="text-gray-600 mb-4">
                      {t(
                        'admin.system.passwordDesc',
                        'Update the admin password. The new password will be encrypted using bcrypt and stored securely.'
                      )}
                    </p>

                    {passwordChangeMessage && (
                      <div
                        className={`p-4 rounded-md mb-4 ${
                          passwordChangeMessage.type === 'success'
                            ? 'bg-green-50 border border-green-200'
                            : 'bg-red-50 border border-red-200'
                        }`}
                      >
                        <div className="flex">
                          <Icon
                            name={passwordChangeMessage.type === 'success' ? 'check' : 'warning'}
                            size="md"
                            className={`mt-0.5 mr-3 ${
                              passwordChangeMessage.type === 'success'
                                ? 'text-green-500'
                                : 'text-red-500'
                            }`}
                          />
                          <p
                            className={`text-sm ${
                              passwordChangeMessage.type === 'success'
                                ? 'text-green-700'
                                : 'text-red-700'
                            }`}
                          >
                            {passwordChangeMessage.text}
                          </p>
                        </div>
                      </div>
                    )}

                    <form onSubmit={handlePasswordChange} className="space-y-4">
                      <div>
                        <label
                          htmlFor="newPassword"
                          className="block text-sm font-medium text-gray-700 mb-2"
                        >
                          {t('admin.system.newPassword', 'New Password')}
                        </label>
                        <input
                          type="password"
                          id="newPassword"
                          value={passwordForm.newPassword}
                          onChange={e =>
                            setPasswordForm(prev => ({ ...prev, newPassword: e.target.value }))
                          }
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-purple-500 focus:border-purple-500 sm:text-sm"
                          placeholder={t(
                            'admin.system.newPasswordPlaceholder',
                            'Enter new password'
                          )}
                          disabled={passwordChangeLoading}
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="confirmPassword"
                          className="block text-sm font-medium text-gray-700 mb-2"
                        >
                          {t('admin.system.confirmPassword', 'Confirm New Password')}
                        </label>
                        <input
                          type="password"
                          id="confirmPassword"
                          value={passwordForm.confirmPassword}
                          onChange={e =>
                            setPasswordForm(prev => ({ ...prev, confirmPassword: e.target.value }))
                          }
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-purple-500 focus:border-purple-500 sm:text-sm"
                          placeholder={t(
                            'admin.system.confirmPasswordPlaceholder',
                            'Confirm new password'
                          )}
                          disabled={passwordChangeLoading}
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={passwordChangeLoading}
                        className={`
                          inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium 
                          rounded-md shadow-sm text-white 
                          ${
                            passwordChangeLoading
                              ? 'bg-gray-400 cursor-not-allowed'
                              : 'bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500'
                          }
                        `}
                      >
                        {passwordChangeLoading ? (
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
                            {t('admin.system.changingPassword', 'Changing Password...')}
                          </>
                        ) : (
                          <>
                            <Icon name="lock" size="md" className="mr-2" />
                            {t('admin.system.changePassword', 'Change Password')}
                          </>
                        )}
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            )}

            {/* Backup/Import Section */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-start space-x-4">
                <div className="flex-shrink-0 mt-1">
                  <div className="p-3 rounded-full bg-green-100">
                    <Icon name="archive-box" size="lg" className="text-green-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    {t('admin.system.backupTitle', 'Configuration Backup & Import')}
                  </h3>
                  <p className="text-gray-600 mb-4">
                    {t(
                      'admin.system.backupDesc',
                      'Export your complete configuration as a ZIP file for disaster recovery, or import a configuration backup to restore your system. This includes all apps, models, groups, custom pages, and frontend customizations (CSS, HTML, etc.).'
                    )}
                  </p>

                  <div className="bg-blue-50 border border-blue-200 rounded-md p-4 mb-4">
                    <div className="flex">
                      <Icon
                        name="information-circle"
                        size="md"
                        className="text-blue-500 mt-0.5 mr-3"
                      />
                      <div>
                        <h4 className="text-sm font-medium text-blue-800">
                          {t('admin.system.backupInfoTitle', "What's included in backups")}
                        </h4>
                        <ul className="text-sm text-blue-700 mt-1 list-disc list-inside space-y-1">
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
                          ? 'bg-green-50 border border-green-200'
                          : 'bg-red-50 border border-red-200'
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
                            importMessage.type === 'success' ? 'text-green-700' : 'text-red-700'
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
                          inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium 
                          rounded-md shadow-sm text-gray-700 bg-white 
                          ${
                            importLoading
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500'
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

                  <div className="mt-4 text-sm text-gray-500">
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
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminSystemPage;
