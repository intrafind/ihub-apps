import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';

const AdminFeaturesPage = () => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { refreshConfig } = usePlatformConfig();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [features, setFeatures] = useState([]);
  const [categories, setCategories] = useState({});
  const [dirtyFlags, setDirtyFlags] = useState({});

  const loadFeatures = async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall('/admin/features', { method: 'GET' });
      setFeatures(response.data.features || []);
      setCategories(response.data.categories || {});
      setDirtyFlags({});
    } catch (error) {
      console.error('Error loading features:', error);
      setMessage(t('admin.features.loadError', 'Failed to load features'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFeatures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggle = (featureId, currentEnabled) => {
    const newEnabled = !currentEnabled;
    setFeatures(prev => prev.map(f => (f.id === featureId ? { ...f, enabled: newEnabled } : f)));
    setDirtyFlags(prev => ({ ...prev, [featureId]: newEnabled }));
  };

  const handleSave = async () => {
    if (Object.keys(dirtyFlags).length === 0) return;

    try {
      setSaving(true);
      setMessage('');

      await makeAdminApiCall('/admin/features', {
        method: 'PUT',
        data: dirtyFlags
      });

      setDirtyFlags({});
      setMessage(t('admin.features.saved', 'Features updated successfully'));
      refreshConfig();

      // Clear success message after a few seconds
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error saving features:', error);
      setMessage(t('admin.features.saveError', 'Failed to save features'));
    } finally {
      setSaving(false);
    }
  };

  // Group features by category and sort by category order
  const groupedFeatures = Object.entries(categories)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .map(([categoryId, category]) => ({
      id: categoryId,
      name: getLocalizedContent(category.name, lang) || categoryId,
      features: features.filter(f => f.category === categoryId)
    }))
    .filter(group => group.features.length > 0);

  const hasChanges = Object.keys(dirtyFlags).length > 0;

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t('admin.features.title', 'Features')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              {t('admin.features.description', 'Enable or disable platform features')}
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <span className="ml-3 text-gray-600 dark:text-gray-400">
                {t('common.loading', 'Loading...')}
              </span>
            </div>
          ) : (
            <div className="space-y-8">
              {groupedFeatures.map(group => (
                <div key={group.id}>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                    {group.name}
                  </h2>
                  <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
                    {group.features.map(feature => (
                      <div key={feature.id} className="flex items-center justify-between px-6 py-4">
                        <div className="flex-1 min-w-0 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                              {getLocalizedContent(feature.name, lang)}
                            </span>
                            {feature.preview && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300">
                                {t('admin.features.preview', 'Preview')}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                            {getLocalizedContent(feature.description, lang)}
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={feature.enabled}
                          onClick={() => handleToggle(feature.id, feature.enabled)}
                          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${
                            feature.enabled ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              feature.enabled ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Save button and message */}
              <div className="flex items-center justify-between pt-4">
                <div>
                  {message && (
                    <p
                      className={`text-sm ${message.includes('Failed') || message.includes('Error') ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}
                    >
                      {message}
                    </p>
                  )}
                </div>
                <button
                  onClick={handleSave}
                  disabled={!hasChanges || saving}
                  className={`px-6 py-2 rounded-lg text-sm font-medium text-white transition-colors ${
                    hasChanges && !saving
                      ? 'bg-indigo-600 hover:bg-indigo-700 cursor-pointer'
                      : 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'
                  }`}
                >
                  {saving
                    ? t('common.saving', 'Saving...')
                    : t('common.saveChanges', 'Save Changes')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminFeaturesPage;
