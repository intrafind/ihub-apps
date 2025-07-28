import { useState, useEffect, useRef } from 'react';
import { makeAdminApiCall } from '../../../api/adminApi';

const AssetManager = ({ t }) => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [showDocumentation, setShowDocumentation] = useState(false);
  const fileInputRef = useRef(null);

  const loadAssets = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await makeAdminApiCall('/admin/ui/assets');
      const data = response.data;
      if (data.success) {
        setAssets(data.assets || []);
      } else {
        throw new Error(data.message || 'Failed to load assets');
      }
    } catch (err) {
      console.error('Failed to load assets:', err);
      setError(err.message || 'Failed to load assets');
      setAssets([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAssets();
  }, []);

  const handleFileUpload = async event => {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = [
      'image/svg+xml',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/x-icon',
      'image/vnd.microsoft.icon'
    ];
    if (!allowedTypes.includes(file.type)) {
      setError('Invalid file type. Only SVG, PNG, JPG, and ICO files are allowed.');
      return;
    }

    // Validate file size (2MB limit)
    if (file.size > 2 * 1024 * 1024) {
      setError('File size must be less than 2MB');
      return;
    }

    try {
      setUploading(true);
      setError(null);
      setSuccessMessage('');

      const formData = new FormData();
      formData.append('asset', file);
      formData.append('assetType', getAssetType(file.type));
      formData.append('description', `Uploaded ${file.name}`);

      const response = await makeAdminApiCall('/admin/ui/upload-asset', {
        method: 'POST',
        body: formData
        // Don't set Content-Type header, let the browser set it for multipart/form-data
      });
      const data = response.data;

      if (data.success) {
        setSuccessMessage(`Successfully uploaded ${file.name}`);
        await loadAssets(); // Refresh the asset list
        setShowUpload(false); // Hide upload section

        // Clear the file input
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }

        // Clear success message after 3 seconds
        setTimeout(() => setSuccessMessage(''), 3000);
      } else {
        throw new Error(data.message || 'Failed to upload asset');
      }
    } catch (err) {
      console.error('Failed to upload asset:', err);
      setError(err.message || 'Failed to upload asset');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteAsset = async assetId => {
    if (
      !confirm(t('admin.ui.assets.confirmDelete', 'Are you sure you want to delete this asset?'))
    ) {
      return;
    }

    try {
      const response = await makeAdminApiCall(`/admin/ui/assets/${assetId}`, {
        method: 'DELETE'
      });
      const data = response.data;

      if (data.success) {
        setSuccessMessage('Asset deleted successfully');
        await loadAssets(); // Refresh the asset list
        setTimeout(() => setSuccessMessage(''), 3000);
      } else {
        throw new Error(data.message || 'Failed to delete asset');
      }
    } catch (err) {
      console.error('Failed to delete asset:', err);
      setError(err.message || 'Failed to delete asset');
    }
  };

  const copyToClipboard = text => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setSuccessMessage('URL copied to clipboard!');
        setTimeout(() => setSuccessMessage(''), 2000);
      })
      .catch(() => {
        setError('Failed to copy to clipboard');
      });
  };

  const getAssetType = mimeType => {
    if (mimeType === 'image/svg+xml') return 'icon';
    if (mimeType.includes('icon')) return 'favicon';
    return 'image';
  };

  const getFileIcon = mimeType => {
    if (mimeType === 'image/svg+xml') return '🎨';
    if (mimeType.includes('icon')) return '🔗';
    return '🖼️';
  };

  const formatFileSize = bytes => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className="p-6 text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mx-auto"></div>
        <p className="mt-2 text-gray-600">{t('admin.ui.assets.loading', 'Loading assets...')}</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-6">
        {t('admin.ui.assets.title', 'Asset Management')}
      </h3>

      {/* Status Messages */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
            <div className="ml-auto pl-3">
              <button
                onClick={() => setError(null)}
                className="inline-flex text-red-400 hover:text-red-600"
              >
                <span className="sr-only">Dismiss</span>
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {successMessage && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-md p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm text-green-800">{successMessage}</p>
            </div>
          </div>
        </div>
      )}

      {/* Upload Section - Collapsible */}
      {showUpload && (
        <div className="mb-8">
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-6">
            <div className="text-center">
              <svg
                className="mx-auto h-12 w-12 text-gray-400"
                stroke="currentColor"
                fill="none"
                viewBox="0 0 48 48"
              >
                <path
                  d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="mt-4">
                <label htmlFor="file-upload" className="cursor-pointer">
                  <span className="mt-2 block text-sm font-medium text-gray-900">
                    {uploading
                      ? t('admin.ui.assets.uploading', 'Uploading...')
                      : t('admin.ui.assets.uploadPrompt', 'Upload a new asset')}
                  </span>
                  <p className="mt-1 text-sm text-gray-600">
                    {t('admin.ui.assets.supportedFormats', 'SVG, PNG, JPG, ICO files up to 2MB')}
                  </p>
                </label>
                <input
                  ref={fileInputRef}
                  id="file-upload"
                  name="file-upload"
                  type="file"
                  className="sr-only"
                  accept=".svg,.png,.jpg,.jpeg,.ico,image/svg+xml,image/png,image/jpeg,image/x-icon,image/vnd.microsoft.icon"
                  onChange={handleFileUpload}
                  disabled={uploading}
                />
              </div>
              <div className="mt-4">
                <button
                  onClick={() => setShowUpload(false)}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  {t('admin.ui.cancel', 'Cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Usage Documentation - Collapsible */}
      <div className="mb-6">
        <button
          onClick={() => setShowDocumentation(!showDocumentation)}
          className="flex items-center space-x-2 text-blue-600 hover:text-blue-800 text-sm font-medium"
        >
          <svg
            className={`h-4 w-4 transform transition-transform ${showDocumentation ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
          </svg>
          <span>{t('admin.ui.assets.usage.title', 'How to Use Uploaded Assets')}</span>
        </button>

        {showDocumentation && (
          <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-6">
            <div className="space-y-3 text-sm text-blue-800">
              <div>
                <h5 className="font-medium">
                  {t('admin.ui.assets.usage.headerLogo', '1. Header Logo:')}
                </h5>
                <p className="ml-4">
                  {t(
                    'admin.ui.assets.usage.headerLogoDesc',
                    'Copy the asset URL and paste it in Header → Logo URL field'
                  )}
                </p>
              </div>
              <div>
                <h5 className="font-medium">{t('admin.ui.assets.usage.favicon', '2. Favicon:')}</h5>
                <p className="ml-4">
                  {t(
                    'admin.ui.assets.usage.faviconDesc',
                    'Upload an ICO file and use the URL in your HTML head section'
                  )}
                </p>
              </div>
              <div>
                <h5 className="font-medium">
                  {t('admin.ui.assets.usage.custom', '3. Custom Content:')}
                </h5>
                <p className="ml-4">
                  {t(
                    'admin.ui.assets.usage.customDesc',
                    'Reference assets in custom CSS, pages, or app configurations using the URL'
                  )}
                </p>
              </div>
              <div className="mt-3 p-3 bg-blue-100 rounded">
                <p className="font-mono text-xs">
                  {t(
                    'admin.ui.assets.usage.example',
                    'Example: <img src="/uploads/assets/logo-123456.png" alt="Logo" />'
                  )}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Assets Table */}
      <div className="space-y-4">
        <div className="sm:flex sm:items-center">
          <div className="sm:flex-auto">
            <h4 className="text-md font-medium text-gray-900">
              {t('admin.ui.assets.uploaded', 'Uploaded Assets')} ({assets.length})
            </h4>
            <p className="mt-1 text-sm text-gray-700">
              {t(
                'admin.ui.assets.description',
                'Manage your uploaded assets and copy their URLs for use in your application'
              )}
            </p>
          </div>
          <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
            {!showUpload && (
              <button
                onClick={() => setShowUpload(true)}
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              >
                <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                {t('admin.ui.assets.addNew', 'Add New Asset')}
              </button>
            )}
          </div>
        </div>

        {assets.length === 0 ? (
          <div className="text-center py-12 bg-gray-50 rounded-lg">
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              {t('admin.ui.assets.noAssets', 'No assets uploaded yet')}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t('admin.ui.assets.uploadFirst', 'Upload your first asset above to get started')}
            </p>
          </div>
        ) : (
          <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
            <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
              <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                <table className="min-w-full divide-y divide-gray-300">
                  <thead className="bg-gray-50">
                    <tr>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.ui.assets.filename', 'Filename')}
                      </th>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.ui.assets.type', 'Type')}
                      </th>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.ui.assets.size', 'Size')}
                      </th>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.ui.assets.url', 'URL')}
                      </th>
                      <th
                        scope="col"
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {t('admin.ui.assets.uploaded', 'Uploaded')}
                      </th>
                      <th scope="col" className="relative px-6 py-3">
                        <span className="sr-only">{t('admin.common.actions', 'Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {assets.map(asset => {
                      return (
                        <tr key={asset.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4">
                            <div className="flex items-center space-x-3">
                              <span className="text-lg">{getFileIcon(asset.mimetype)}</span>
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-gray-900 truncate max-w-xs">
                                  {asset.originalName}
                                </div>
                                <div className="text-xs text-gray-500 font-mono truncate max-w-xs">
                                  {asset.filename}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                              {asset.assetType || 'general'}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {formatFileSize(asset.size)}
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center space-x-2 max-w-sm">
                              <input
                                type="text"
                                value={asset.publicUrl}
                                readOnly
                                className="flex-1 text-xs bg-gray-50 border border-gray-300 rounded px-2 py-1 font-mono min-w-0"
                              />
                              <button
                                onClick={() => copyToClipboard(asset.publicUrl)}
                                className="flex-shrink-0 inline-flex items-center px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                title={t('admin.ui.assets.copyUrl', 'Copy URL')}
                              >
                                <svg
                                  className="h-3 w-3"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="2"
                                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                  />
                                </svg>
                              </button>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {new Date(asset.uploadedAt).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                            <button
                              onClick={() => handleDeleteAsset(asset.id)}
                              className="text-red-600 hover:text-red-900 focus:outline-none focus:ring-2 focus:ring-red-500 rounded p-1"
                              title={t('admin.ui.assets.delete', 'Delete asset')}
                            >
                              <svg
                                className="h-4 w-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="2"
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AssetManager;
