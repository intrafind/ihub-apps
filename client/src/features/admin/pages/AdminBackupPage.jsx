import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

function AdminBackupPage() {
  const { t } = useTranslation();
  const fileInputRef = useRef(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importMessage, setImportMessage] = useState('');

  const handleExportConfig = async () => {
    setExportLoading(true);
    try {
      const response = await makeAdminApiCall('/admin/backup/export', {
        method: 'GET',
        responseType: 'blob'
      });

      const blob = response.data;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');

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

    setImportLoading(true);
    setImportMessage('');

    try {
      const formData = new FormData();
      formData.append('backup', file);

      const response = await makeAdminApiCall('/admin/backup/import', {
        method: 'POST',
        data: formData,
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      const data = response.data;
      setImportMessage({
        type: 'success',
        text: t(
          'admin.system.importSuccess',
          'Configuration imported successfully! {{fileCount}} files imported. Current configuration backed up as: {{backup}}',
          { fileCount: data.importedFiles, backup: data.backupPath }
        )
      });

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
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
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t('admin.nav.backup', 'Backup & Restore')}
        </h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('admin.backup.description', 'Export and import your platform configuration')}
        </p>
      </div>

      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start space-x-4">
            <div className="flex-shrink-0 mt-1">
              <div className="p-3 rounded-full bg-green-100 dark:bg-green-900/50">
                <Icon name="archive-box" size="lg" className="text-green-600 dark:text-green-400" />
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
                  <Icon name="information-circle" size="md" className="text-blue-500 mt-0.5 mr-3" />
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
                      <li>{t('admin.system.backupInfo2', 'Custom pages and React components')}</li>
                      <li>
                        {t('admin.system.backupInfo3', 'Prompt templates and localization files')}
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
                      className={`mt-0.5 mr-3 ${importMessage.type === 'success' ? 'text-green-500' : 'text-red-500'}`}
                    />
                    <p
                      className={`text-sm ${importMessage.type === 'success' ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}
                    >
                      {importMessage.text}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-4">
                <button
                  onClick={handleExportConfig}
                  disabled={exportLoading}
                  className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white ${
                    exportLoading
                      ? 'bg-gray-400 cursor-not-allowed'
                      : 'bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500'
                  }`}
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
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
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
                    className={`inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md shadow-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 ${
                      importLoading
                        ? 'cursor-not-allowed opacity-50'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500'
                    }`}
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
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
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
      </div>
    </div>
  );
}

export default AdminBackupPage;
