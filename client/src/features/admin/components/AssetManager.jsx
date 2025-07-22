import React, { useState, useEffect, useRef } from 'react';
import { makeAdminApiCall } from '../../../api/adminApi';

const AssetManager = ({ t }) => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const fileInputRef = useRef(null);

  const loadAssets = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await makeAdminApiCall('/api/admin/ui/assets');
      if (response.success) {
        setAssets(response.assets || []);
      } else {
        throw new Error(response.message || 'Failed to load assets');
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

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/jpg', 'image/x-icon', 'image/vnd.microsoft.icon'];
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

      const response = await makeAdminApiCall('/api/admin/ui/upload-asset', {
        method: 'POST',
        body: formData,
        // Don't set Content-Type header, let the browser set it for multipart/form-data
      });

      if (response.success) {
        setSuccessMessage(`Successfully uploaded ${file.name}`);
        await loadAssets(); // Refresh the asset list
        
        // Clear the file input
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }

        // Clear success message after 3 seconds
        setTimeout(() => setSuccessMessage(''), 3000);
      } else {
        throw new Error(response.message || 'Failed to upload asset');
      }
    } catch (err) {
      console.error('Failed to upload asset:', err);
      setError(err.message || 'Failed to upload asset');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteAsset = async (assetId) => {
    if (!confirm(t('admin.ui.assets.confirmDelete', 'Are you sure you want to delete this asset?'))) {
      return;
    }

    try {
      const response = await makeAdminApiCall(`/api/admin/ui/assets/${assetId}`, {
        method: 'DELETE',
      });

      if (response.success) {
        setSuccessMessage('Asset deleted successfully');
        await loadAssets(); // Refresh the asset list
        setTimeout(() => setSuccessMessage(''), 3000);
      } else {
        throw new Error(response.message || 'Failed to delete asset');
      }
    } catch (err) {
      console.error('Failed to delete asset:', err);
      setError(err.message || 'Failed to delete asset');
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      setSuccessMessage('URL copied to clipboard!');
      setTimeout(() => setSuccessMessage(''), 2000);
    }).catch(() => {
      setError('Failed to copy to clipboard');
    });
  };

  const getAssetType = (mimeType) => {
    if (mimeType === 'image/svg+xml') return 'icon';
    if (mimeType.includes('icon')) return 'favicon';
    return 'image';
  };

  const getFileIcon = (mimeType) => {
    if (mimeType === 'image/svg+xml') return '🎨';
    if (mimeType.includes('icon')) return '🔗';
    return '🖼️';
  };

  const formatFileSize = (bytes) => {
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
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
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
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
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
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm text-green-800">{successMessage}</p>
            </div>
          </div>
        </div>
      )}

      {/* Upload Section */}
      <div className="mb-8">
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6">
          <div className="text-center">
            <svg className="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
              <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="mt-4">
              <label htmlFor="file-upload" className="cursor-pointer">
                <span className="mt-2 block text-sm font-medium text-gray-900">
                  {uploading 
                    ? t('admin.ui.assets.uploading', 'Uploading...') 
                    : t('admin.ui.assets.uploadPrompt', 'Upload a new asset')
                  }
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
          </div>
        </div>
      </div>

      {/* Assets Grid */}
      <div className="space-y-4">
        <h4 className="text-md font-medium text-gray-900">
          {t('admin.ui.assets.uploaded', 'Uploaded Assets')} ({assets.length})
        </h4>

        {assets.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <p>{t('admin.ui.assets.noAssets', 'No assets uploaded yet')}</p>
            <p className="text-sm">{t('admin.ui.assets.uploadFirst', 'Upload your first asset above')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {assets.map((asset) => (
              <div key={asset.id} className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl">{getFileIcon(asset.mimetype)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">{asset.filename}</p>
                      <p className="text-xs text-gray-500">{formatFileSize(asset.size)}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteAsset(asset.id)}
                    className="text-red-400 hover:text-red-600"
                    title={t('admin.ui.assets.delete', 'Delete asset')}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>

                {/* Asset Preview */}
                {asset.isImage && (
                  <div className="mb-3">
                    <img
                      src={asset.publicUrl}
                      alt={asset.filename}
                      className="w-full h-20 object-contain bg-white border border-gray-200 rounded"
                    />
                  </div>
                )}

                {/* Public URL */}
                <div className="bg-white rounded border border-gray-200 p-2">
                  <div className="flex items-center justify-between">
                    <code className="text-xs text-gray-600 truncate flex-1 mr-2">
                      {asset.publicUrl}
                    </code>
                    <button
                      onClick={() => copyToClipboard(asset.publicUrl)}
                      className="text-indigo-600 hover:text-indigo-800 flex-shrink-0"
                      title={t('admin.ui.assets.copyUrl', 'Copy URL')}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Upload Date */}
                <p className="text-xs text-gray-500 mt-2">
                  {t('admin.ui.assets.uploaded', 'Uploaded')}: {new Date(asset.uploadedAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AssetManager;