import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const ConfigFileManager = ({ configType, onUploadSuccess, onUploadError, className = '' }) => {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [showUploadDetails, setShowUploadDetails] = useState(false);

  const handleDownload = async () => {
    try {
      const response = await fetch(`/api/admin/config-files/${configType}/download`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.statusText}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `${configType}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
      if (onUploadError) {
        onUploadError(`Failed to download ${configType} configuration: ${error.message}`);
      }
    }
  };

  const handleFileUpload = async event => {
    const file = event.target.files[0];
    if (!file) return;

    setUploading(true);
    setUploadResult(null);

    try {
      const formData = new FormData();
      formData.append('config', file);
      formData.append('replace', 'false'); // Default to merge mode

      const response = await fetch(`/api/admin/config-files/${configType}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || `Upload failed: ${response.statusText}`);
      }

      setUploadResult(result);
      setShowUploadDetails(true);

      if (onUploadSuccess) {
        onUploadSuccess(result);
      }
    } catch (error) {
      console.error('Upload error:', error);
      setUploadResult({
        error: error.message,
        validationErrors: error.validationErrors,
        conflictingIds: error.conflictingIds
      });
      setShowUploadDetails(true);

      if (onUploadError) {
        onUploadError(error.message);
      }
    } finally {
      setUploading(false);
      // Clear the input
      event.target.value = '';
    }
  };

  const handleReplaceUpload = async file => {
    setUploading(true);
    setUploadResult(null);

    try {
      const formData = new FormData();
      formData.append('config', file);
      formData.append('replace', 'true'); // Replace mode

      const response = await fetch(`/api/admin/config-files/${configType}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || `Upload failed: ${response.statusText}`);
      }

      setUploadResult(result);
      setShowUploadDetails(true);

      if (onUploadSuccess) {
        onUploadSuccess(result);
      }
    } catch (error) {
      console.error('Replace upload error:', error);
      setUploadResult({
        error: error.message,
        validationErrors: error.validationErrors
      });
      setShowUploadDetails(true);

      if (onUploadError) {
        onUploadError(error.message);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleBackup = async () => {
    try {
      const response = await fetch(`/api/admin/config-files/${configType}/backup`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || `Backup failed: ${response.statusText}`);
      }

      // Show success message
      alert(result.message);
    } catch (error) {
      console.error('Backup error:', error);
      if (onUploadError) {
        onUploadError(`Failed to backup ${configType} configuration: ${error.message}`);
      }
    }
  };

  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 ${className}`}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          {t(
            `admin.${configType}.fileManager`,
            `${configType.charAt(0).toUpperCase() + configType.slice(1)} File Manager`
          )}
        </h3>
        <div className="flex items-center space-x-2">
          <button
            onClick={handleBackup}
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            <Icon name="archive" className="w-3 h-3 mr-1" />
            {t('admin.backup', 'Backup')}
          </button>
          <button
            onClick={handleDownload}
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            <Icon name="download" className="w-3 h-3 mr-1" />
            {t('admin.download', 'Download')}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.uploadConfig', 'Upload Configuration File')}
          </label>
          <div className="flex items-center space-x-2">
            <input
              type="file"
              accept=".json"
              onChange={handleFileUpload}
              disabled={uploading}
              className="block w-full text-sm text-gray-500 dark:text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900 dark:file:text-blue-300 dark:hover:file:bg-blue-800"
            />
            {uploading && (
              <div className="flex items-center">
                <Icon name="loading" className="w-4 h-4 animate-spin text-blue-600" />
                <span className="ml-2 text-sm text-gray-600 dark:text-gray-400">
                  {t('admin.uploading', 'Uploading...')}
                </span>
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.uploadHint',
              'Select a JSON file to upload. New items will be added to existing configuration.'
            )}
          </p>
        </div>

        {showUploadDetails && uploadResult && (
          <div
            className={`p-3 rounded-md ${uploadResult.error ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800' : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'}`}
          >
            {uploadResult.error ? (
              <div>
                <div className="flex items-center">
                  <Icon name="exclamation-triangle" className="w-5 h-5 text-red-500 mr-2" />
                  <h4 className="text-sm font-medium text-red-800 dark:text-red-200">
                    {t('admin.uploadFailed', 'Upload Failed')}
                  </h4>
                </div>
                <p className="mt-1 text-sm text-red-700 dark:text-red-300">{uploadResult.error}</p>

                {uploadResult.conflictingIds && uploadResult.conflictingIds.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm text-red-700 dark:text-red-300 font-medium">
                      {t('admin.conflictingIds', 'Conflicting IDs:')}
                    </p>
                    <ul className="mt-1 text-sm text-red-600 dark:text-red-400">
                      {uploadResult.conflictingIds.map(id => (
                        <li key={id} className="font-mono">
                          • {id}
                        </li>
                      ))}
                    </ul>
                    <button
                      onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = '.json';
                        input.onchange = e => {
                          if (e.target.files[0]) {
                            handleReplaceUpload(e.target.files[0]);
                          }
                        };
                        input.click();
                      }}
                      disabled={uploading}
                      className="mt-2 inline-flex items-center px-3 py-1.5 text-xs font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                    >
                      <Icon name="upload" className="w-3 h-3 mr-1" />
                      {t('admin.replaceAll', 'Replace All')}
                    </button>
                  </div>
                )}

                {uploadResult.validationErrors && uploadResult.validationErrors.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm text-red-700 dark:text-red-300 font-medium">
                      {t('admin.validationErrors', 'Validation Errors:')}
                    </p>
                    <div className="mt-1 space-y-1">
                      {uploadResult.validationErrors.map((error, index) => (
                        <div key={index} className="text-sm text-red-600 dark:text-red-400">
                          <span className="font-mono">{error.id}:</span> {error.errors.join(', ')}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="flex items-center">
                  <Icon name="check-circle" className="w-5 h-5 text-green-500 mr-2" />
                  <h4 className="text-sm font-medium text-green-800 dark:text-green-200">
                    {t('admin.uploadSuccess', 'Upload Successful')}
                  </h4>
                </div>
                <p className="mt-1 text-sm text-green-700 dark:text-green-300">
                  {uploadResult.message}
                </p>
                <div className="mt-2 text-xs text-green-600 dark:text-green-400">
                  <p>
                    {t('admin.uploaded', 'Uploaded')}: {uploadResult.uploaded}{' '}
                    {t('admin.items', 'items')}
                  </p>
                  <p>
                    {t('admin.total', 'Total')}: {uploadResult.total} {t('admin.items', 'items')}
                  </p>
                  <p>
                    {t('admin.mode', 'Mode')}: {uploadResult.mode}
                  </p>
                </div>
              </div>
            )}

            <button
              onClick={() => setShowUploadDetails(false)}
              className="mt-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
            >
              {t('admin.dismiss', 'Dismiss')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ConfigFileManager;
