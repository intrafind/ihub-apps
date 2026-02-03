import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LANGUAGE } from '../../../utils/localizeContent';
import { makeAdminApiCall } from '../../../api/adminApi';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';

const AdminProviderCreatePage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const [formData, setFormData] = useState({
    id: '',
    name: { [DEFAULT_LANGUAGE]: '', de: '' },
    description: { [DEFAULT_LANGUAGE]: '', de: '' },
    enabled: true,
    category: 'custom',
    apiKey: ''
  });

  const handleChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleLocalizedChange = (field, lang, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: {
        ...prev[field],
        [lang]: value
      }
    }));
  };

  const handleSave = async e => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);

      // Validation
      if (!formData.id.trim()) {
        setError('Provider ID is required');
        return;
      }

      if (!formData.name.en.trim()) {
        setError('Provider name (English) is required');
        return;
      }

      if (!formData.description.en.trim()) {
        setError('Provider description (English) is required');
        return;
      }

      // Prepare the data to send
      const dataToSend = {
        ...formData,
        // Remove empty API key
        apiKey: formData.apiKey.trim() || undefined
      };

      await makeAdminApiCall('/admin/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(dataToSend)
      });

      setSuccess(true);

      // Redirect after a short delay
      setTimeout(() => {
        navigate('/admin/providers');
      }, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AdminNavigation />

        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <button
              onClick={() => navigate('/admin/providers')}
              className="inline-flex items-center text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-4"
            >
              <Icon name="ArrowLeftIcon" className="w-4 h-4 mr-2" />
              {t('admin.providers.backToList', 'Back to Providers')}
            </button>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              {t('admin.providers.create.title', 'Create New Provider')}
            </h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.providers.create.description',
                'Create a new custom provider for storing API keys'
              )}
            </p>
          </div>

          {/* Success Message */}
          {success && (
            <div className="mb-6 p-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg">
              <div className="flex items-center">
                <Icon
                  name="CheckCircleIcon"
                  className="w-5 h-5 text-green-600 dark:text-green-400 mr-2"
                />
                <p className="text-sm text-green-600 dark:text-green-400">
                  {t('admin.providers.create.saved', 'Provider created successfully!')}
                </p>
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-center">
                <Icon
                  name="ExclamationCircleIcon"
                  className="w-5 h-5 text-red-600 dark:text-red-400 mr-2"
                />
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSave} className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            {/* Provider ID */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.providers.create.id', 'Provider ID')} *
              </label>
              <input
                type="text"
                value={formData.id}
                onChange={e => handleChange('id', e.target.value)}
                placeholder="my-custom-provider"
                required
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.providers.create.idHelp',
                  'Unique identifier (lowercase, use hyphens instead of spaces)'
                )}
              </p>
            </div>

            {/* Provider Name */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.providers.create.name', 'Provider Name')} *
              </label>
              <div className="space-y-2">
                <input
                  type="text"
                  value={formData.name.en || ''}
                  onChange={e => handleLocalizedChange('name', 'en', e.target.value)}
                  placeholder="English"
                  required
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
                <input
                  type="text"
                  value={formData.name.de || ''}
                  onChange={e => handleLocalizedChange('name', 'de', e.target.value)}
                  placeholder="Deutsch"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>
            </div>

            {/* Provider Description */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.providers.create.description', 'Description')} *
              </label>
              <div className="space-y-2">
                <textarea
                  value={formData.description.en || ''}
                  onChange={e => handleLocalizedChange('description', 'en', e.target.value)}
                  placeholder="English"
                  rows={2}
                  required
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white resize-none"
                />
                <textarea
                  value={formData.description.de || ''}
                  onChange={e => handleLocalizedChange('description', 'de', e.target.value)}
                  placeholder="Deutsch"
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white resize-none"
                />
              </div>
            </div>

            {/* Category */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.providers.create.category', 'Category')}
              </label>
              <select
                value={formData.category}
                onChange={e => handleChange('category', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              >
                <option value="custom">Custom / Generic</option>
                <option value="websearch">Web Search</option>
              </select>
            </div>

            {/* API Key */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.providers.create.apiKey', 'API Key')}
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  {t('admin.providers.create.apiKeyOptional', '(Optional)')}
                </span>
              </label>
              <input
                type="password"
                value={formData.apiKey}
                onChange={e => handleChange('apiKey', e.target.value)}
                placeholder={t('admin.providers.create.apiKeyEnter', 'Enter API key')}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />
            </div>

            {/* Enabled Toggle */}
            <div className="mb-6">
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.enabled}
                  onChange={e => handleChange('enabled', e.target.checked)}
                  className="w-4 h-4 text-blue-600 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 rounded focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.providers.create.enabled', 'Provider Enabled')}
                </span>
              </label>
            </div>

            {/* Action Buttons */}
            <div className="flex justify-end space-x-4">
              <button
                type="button"
                onClick={() => navigate('/admin/providers')}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {t('admin.providers.create.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving
                  ? t('admin.providers.create.saving', 'Creating...')
                  : t('admin.providers.create.save', 'Create Provider')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminProviderCreatePage;
