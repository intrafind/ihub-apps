import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import Icon from '../../../shared/components/Icon';
import ProviderFormFields from '../components/ProviderFormFields';
import { slugify } from '../utils/modelImport';

function AdminProviderCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const [formData, setFormData] = useState({
    id: '',
    name: '',
    description: '',
    enabled: true,
    category: 'llm',
    apiType: 'openai',
    baseUrl: '',
    apiKey: ''
  });
  // The ID follows the name until the admin types one of their own.
  const [idEdited, setIdEdited] = useState(false);

  const handleChange = (field, value) => {
    if (field === 'id') setIdEdited(true);
    setFormData(prev => {
      const next = { ...prev, [field]: value };
      if (field === 'name' && !idEdited) next.id = slugify(value);
      return next;
    });
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

      if (!formData.name.trim()) {
        setError(t('admin.providers.create.nameRequired', 'Provider name is required'));
        return;
      }

      // Prepare the data to send
      const dataToSend = {
        ...formData,
        // Remove empty API key
        apiKey: formData.apiKey.trim() || undefined,
        baseUrl: formData.baseUrl.trim() || undefined
      };
      if (formData.category !== 'llm') {
        delete dataToSend.apiType;
        delete dataToSend.baseUrl;
      }

      await makeAdminApiCall('/admin/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: dataToSend
      });

      setSuccess(true);

      // Redirect after a short delay
      setTimeout(() => {
        navigate('/admin/providers');
      }, 1500);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
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
              'admin.providers.create.subtitle',
              'Create an LLM provider for your own endpoint, a web search provider, or a generic API key'
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
        <form onSubmit={handleSave} className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6">
          {/* Category */}
          <div className="mb-6">
            <label
              htmlFor="provider-category"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
            >
              {t('admin.providers.create.category', 'Category')}
            </label>
            <select
              id="provider-category"
              value={formData.category}
              onChange={e => handleChange('category', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            >
              <option value="llm">{t('admin.providers.category.llm', 'LLM Providers')}</option>
              <option value="websearch">
                {t('admin.providers.category.websearch', 'Web Search Providers')}
              </option>
              <option value="custom">
                {t('admin.providers.category.custom', 'Custom / Generic API Keys')}
              </option>
            </select>
            {formData.category === 'llm' && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.providers.create.llmHelp',
                  'An LLM provider holds one API key for all of its models. Link models to it in the model editor, or import them from its endpoint.'
                )}
              </p>
            )}
          </div>

          <ProviderFormFields
            data={formData}
            onChange={handleChange}
            isNew
            isLlm={formData.category === 'llm'}
          />

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
                className="w-4 h-4 text-blue-600 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 rounded-sm focus:ring-blue-500"
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
  );
}

export default AdminProviderCreatePage;
