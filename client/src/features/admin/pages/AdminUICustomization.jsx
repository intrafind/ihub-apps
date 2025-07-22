import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import HeaderCustomization from '../components/HeaderCustomization';
import FooterCustomization from '../components/FooterCustomization';
import AssetManager from '../components/AssetManager';
import StyleEditor from '../components/StyleEditor';
import ContentEditor from '../components/ContentEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

const AdminUICustomization = () => {
  const { t } = useTranslation();
  const { uiConfig, refreshUIConfig } = useUIConfig();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [activeTab, setActiveTab] = useState('header');

  // Load UI configuration on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const response = await makeAdminApiCall('/api/admin/ui/config');
        if (response.success) {
          setConfig(response.config);
        } else {
          throw new Error(response.message || 'Failed to load configuration');
        }
      } catch (err) {
        console.error('Failed to load UI config:', err);
        setError(err.message || 'Failed to load configuration');
        // Fallback to the cached UI config if available
        if (uiConfig) {
          setConfig(uiConfig);
        }
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, [uiConfig]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage('');

      const response = await makeAdminApiCall('/api/admin/ui/config', {
        method: 'POST',
        body: JSON.stringify({ config }),
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.success) {
        setSuccessMessage('UI configuration saved successfully');
        // Refresh the UI config context to apply changes immediately
        await refreshUIConfig();
        
        // Clear success message after 3 seconds
        setTimeout(() => setSuccessMessage(''), 3000);
      } else {
        throw new Error(response.message || 'Failed to save configuration');
      }
    } catch (err) {
      console.error('Failed to save UI config:', err);
      setError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleBackup = async () => {
    try {
      const response = await makeAdminApiCall('/api/admin/ui/backup', {
        method: 'POST',
      });

      if (response.success) {
        setSuccessMessage(`Configuration backed up to: ${response.backupPath}`);
        setTimeout(() => setSuccessMessage(''), 5000);
      } else {
        throw new Error(response.message || 'Failed to create backup');
      }
    } catch (err) {
      console.error('Failed to backup config:', err);
      setError(err.message || 'Failed to create backup');
    }
  };

  const updateConfig = (section, updates) => {
    setConfig(prevConfig => ({
      ...prevConfig,
      [section]: {
        ...prevConfig[section],
        ...updates
      }
    }));
  };

  const tabs = [
    { id: 'header', label: t('admin.ui.tabs.header', 'Header'), icon: '🎨' },
    { id: 'footer', label: t('admin.ui.tabs.footer', 'Footer'), icon: '📄' },
    { id: 'assets', label: t('admin.ui.tabs.assets', 'Assets'), icon: '🖼️' },
    { id: 'styles', label: t('admin.ui.tabs.styles', 'Styles'), icon: '🎯' },
    { id: 'content', label: t('admin.ui.tabs.content', 'Content'), icon: '📝' }
  ];

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
            <p className="mt-2 text-gray-600">{t('admin.ui.loading', 'Loading UI configuration...')}</p>
          </div>
        </div>
      </AdminAuth>
    );
  }

  if (!config) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <p className="text-red-600">{error || t('admin.ui.error', 'Failed to load configuration')}</p>
          </div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="sm:flex sm:items-center sm:justify-between">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">
                  {t('admin.ui.title', 'UI Customization')}
                </h1>
                <p className="text-gray-600 mt-1">
                  {t('admin.ui.description', 'Customize the appearance and branding of your AI Hub Apps')}
                </p>
              </div>
              <div className="mt-4 sm:mt-0 sm:flex sm:space-x-3">
                <button
                  onClick={handleBackup}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  {t('admin.ui.backup', 'Backup Config')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className={`inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${
                    saving 
                      ? 'bg-indigo-400 cursor-not-allowed' 
                      : 'bg-indigo-600 hover:bg-indigo-700'
                  } focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500`}
                >
                  {saving ? t('admin.ui.saving', 'Saving...') : t('admin.ui.save', 'Save Changes')}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Status Messages */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mx-4 mt-4">
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
          <div className="bg-green-50 border border-green-200 rounded-md p-4 mx-4 mt-4">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <p className="text-sm text-green-800">{successMessage}</p>
              </div>
              <div className="ml-auto pl-3">
                <button
                  onClick={() => setSuccessMessage('')}
                  className="inline-flex text-green-400 hover:text-green-600"
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

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Tab Navigation */}
          <div className="border-b border-gray-200 mb-8">
            <nav className="flex space-x-8" aria-label="Tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`py-2 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 ${
                    activeTab === tab.id
                      ? 'border-indigo-500 text-indigo-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              ))}
            </nav>
          </div>

          {/* Tab Content */}
          <div className="bg-white rounded-lg shadow">
            {activeTab === 'header' && (
              <HeaderCustomization
                config={config.header || {}}
                onUpdate={(updates) => updateConfig('header', updates)}
                t={t}
              />
            )}
            {activeTab === 'footer' && (
              <FooterCustomization
                config={config.footer || {}}
                onUpdate={(updates) => updateConfig('footer', updates)}
                t={t}
              />
            )}
            {activeTab === 'assets' && (
              <AssetManager t={t} />
            )}
            {activeTab === 'styles' && (
              <StyleEditor
                config={config}
                onUpdate={setConfig}
                t={t}
              />
            )}
            {activeTab === 'content' && (
              <ContentEditor
                config={config}
                onUpdate={setConfig}
                t={t}
              />
            )}
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminUICustomization;