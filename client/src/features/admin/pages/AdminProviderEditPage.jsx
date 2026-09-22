import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LANGUAGE } from '../../../utils/localizeContent';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import Icon from '../../../shared/components/Icon';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import WebsearchTestResult from '../components/WebsearchTestResult';

function AdminProviderEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { providerId } = useParams();

  // Constants
  const API_KEY_PLACEHOLDER = '••••••••';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [initialData, setInitialData] = useState(null);

  const [formData, setFormData] = useState({
    id: '',
    name: { [DEFAULT_LANGUAGE]: '' },
    description: { [DEFAULT_LANGUAGE]: '' },
    enabled: true,
    apiKey: '',
    apiKeySet: false
  });

  // Connectivity test state — kept out of formData so running a test never
  // looks like an unsaved edit.
  const [testQuery, setTestQuery] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const { blocker, markSaved } = useUnsavedChanges(initialData, formData);

  const isWebsearchProvider = formData.category === 'websearch';

  /**
   * Run one live search through this provider and show the verdict.
   *
   * The endpoint answers 200 even when the provider refuses us — a DataDome
   * block is a finding, not a failed request — so only a genuinely broken call
   * lands in the catch.
   */
  const runWebsearchTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await makeAdminApiCall(`/admin/providers/${providerId}/websearch-test`, {
        method: 'POST',
        body: testQuery.trim() ? { query: testQuery.trim() } : {}
      });
      setTestResult(response?.data || null);
    } catch (err) {
      setTestResult({
        diagnosis: {
          status: 'error',
          title: t('admin.providers.websearchTest.couldNotRun', 'Could not run the test'),
          detail: getAdminApiErrorMessage(err),
          remediation: []
        },
        results: [],
        environment: {}
      });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    loadProvider();
  }, [providerId]); // eslint-disable-line @eslint-react/exhaustive-deps

  const loadProvider = useCallback(async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall(`/admin/providers/${providerId}`);
      const provider = response.data;

      // Ensure name and description are proper localized objects
      const ensureLocalizedObject = value => {
        if (!value) return { [DEFAULT_LANGUAGE]: '' };
        if (typeof value === 'string') return { [DEFAULT_LANGUAGE]: value };
        if (typeof value === 'object' && value !== null) return value;
        return { [DEFAULT_LANGUAGE]: '' };
      };

      const formDataObj = {
        ...provider,
        id: provider.id || '',
        name: ensureLocalizedObject(provider.name),
        description: ensureLocalizedObject(provider.description),
        enabled: provider.enabled !== undefined ? provider.enabled : true
      };

      // Handle API key display - show placeholder if key is set
      if (provider.apiKeySet) {
        formDataObj.apiKeySet = true;
        formDataObj.apiKey = provider.apiKeyMasked || API_KEY_PLACEHOLDER;
      } else {
        formDataObj.apiKeySet = false;
        formDataObj.apiKey = '';
      }

      setFormData(formDataObj);
      setInitialData(formDataObj);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

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

      // Prepare the data to send
      const dataToSend = {
        ...formData
      };

      // Handle API key:
      // - If it's the masked placeholder and a key was previously set, keep it (backend will preserve)
      // - If it's empty and a key was set, remove it (user wants to clear it)
      // - If it's a new value, send it (user is setting/updating the key)
      if (dataToSend.apiKey === API_KEY_PLACEHOLDER || dataToSend.apiKey === '') {
        if (formData.apiKeySet && dataToSend.apiKey === API_KEY_PLACEHOLDER) {
          // Keep the placeholder so backend knows to preserve the existing key
          dataToSend.apiKey = API_KEY_PLACEHOLDER;
        } else if (dataToSend.apiKey === '') {
          // Empty string - remove the field to avoid confusion
          delete dataToSend.apiKey;
        }
      }

      // Remove helper fields that shouldn't be sent to backend
      delete dataToSend.apiKeySet;
      delete dataToSend.apiKeyMasked;

      await makeAdminApiCall(`/admin/providers/${providerId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: dataToSend
      });

      setSuccess(true);
      markSaved();

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

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminBreadcrumb
          crumbs={[
            { label: 'Admin', href: '/admin' },
            { label: 'Providers', href: '/admin/providers' },
            { label: formData?.name?.en ?? providerId }
          ]}
        />
        <div className="mb-6">
          <button
            onClick={() => navigate('/admin/providers')}
            className="inline-flex items-center text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-4"
          >
            <Icon name="ArrowLeftIcon" className="w-4 h-4 mr-2" />
            {t('admin.providers.backToList', 'Back to Providers')}
          </button>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            {t('admin.providers.edit.title', 'Configure Provider')}
          </h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t('admin.providers.edit.description', 'Configure API credentials for this provider')}
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
                {t('admin.providers.edit.saved', 'Provider configuration saved successfully!')}
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
          {/* Provider ID (Read-only) */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.providers.edit.id', 'Provider ID')}
            </label>
            <input
              type="text"
              value={formData.id}
              disabled
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed"
            />
          </div>

          {/* Provider Name */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.providers.edit.name', 'Provider Name')}
            </label>
            <div className="space-y-2">
              <input
                type="text"
                value={formData.name.en || ''}
                onChange={e => handleLocalizedChange('name', 'en', e.target.value)}
                placeholder="English"
                disabled
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed"
              />
              <input
                type="text"
                value={formData.name.de || ''}
                onChange={e => handleLocalizedChange('name', 'de', e.target.value)}
                placeholder="Deutsch"
                disabled
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed"
              />
            </div>
          </div>

          {/* Provider Description */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.providers.edit.description', 'Description')}
            </label>
            <div className="space-y-2">
              <textarea
                value={formData.description.en || ''}
                onChange={e => handleLocalizedChange('description', 'en', e.target.value)}
                placeholder="English"
                rows={2}
                disabled
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed resize-none"
              />
              <textarea
                value={formData.description.de || ''}
                onChange={e => handleLocalizedChange('description', 'de', e.target.value)}
                placeholder="Deutsch"
                rows={2}
                disabled
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed resize-none"
              />
            </div>
          </div>

          {/* API Key */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.providers.edit.apiKey', 'API Key')}
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.providers.edit.apiKeyOptional',
                  '(Optional - leave empty to use environment variable)'
                )}
              </span>
            </label>
            <input
              type="password"
              value={formData.apiKey}
              onChange={e => handleChange('apiKey', e.target.value)}
              placeholder={
                formData.apiKeySet
                  ? t(
                      'admin.providers.edit.apiKeyPlaceholder',
                      'Enter new API key or leave unchanged'
                    )
                  : t('admin.providers.edit.apiKeyEnter', 'Enter API key')
              }
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
            {formData.apiKeySet && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                <Icon name="KeyIcon" className="w-3 h-3 inline mr-1" />
                {t('admin.providers.edit.apiKeySet', 'An API key is currently configured')}
              </p>
            )}
          </div>

          {/* Info Box */}
          <div className="mb-6 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="flex items-start">
              <Icon
                name="InformationCircleIcon"
                className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 mr-2 shrink-0"
              />
              <div className="text-sm text-blue-700 dark:text-blue-300">
                <p className="font-medium mb-1">
                  {t('admin.providers.edit.info.title', 'About Provider API Keys')}
                </p>
                <p>
                  {t(
                    'admin.providers.edit.info.description',
                    'API keys configured here are used as a fallback for all models of this provider that do not have their own API key configured. If you leave this field empty, the system will use the environment variable instead.'
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Enabled Toggle */}
          <div className="mb-6">
            <label className="flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={formData.enabled}
                onChange={e => handleChange('enabled', e.target.checked)}
                disabled
                className="w-4 h-4 text-blue-600 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 rounded-sm focus:ring-blue-500 cursor-not-allowed"
              />
              <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                {t('admin.providers.edit.enabled', 'Provider Enabled')}
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
              {t('admin.providers.edit.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving
                ? t('admin.providers.edit.saving', 'Saving...')
                : t('admin.providers.edit.save', 'Save Changes')}
            </button>
          </div>
        </form>

        {/* Connectivity test — web search providers only.
            Deliberately outside the <form>: a button inside one submits it, and
            "Test" must never save. Saving first still matters, since the test
            runs against the stored configuration, which is what the hint says. */}
        {isWebsearchProvider && (
          <div className="mt-6 bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">
              {t('admin.providers.websearchTest.title', 'Connectivity Test')}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.providers.websearchTest.description',
                'Runs one real search from this server, bypassing the result cache, and reports whether the provider answered. This is the only way to find out whether bot protection (such as the DataDome layer in front of Qwant) is blocking this server’s IP address — that is decided by where the server sends traffic from, not by the settings on this page.'
              )}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.providers.websearchTest.savedConfigHint',
                'The test uses the saved configuration — save your changes first to test them.'
              )}
            </p>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label
                  htmlFor="websearch-test-query"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.providers.websearchTest.queryLabel', 'Test query (optional)')}
                </label>
                <input
                  id="websearch-test-query"
                  type="text"
                  maxLength={100}
                  value={testQuery}
                  onChange={e => setTestQuery(e.target.value)}
                  placeholder={t(
                    'admin.providers.websearchTest.queryPlaceholder',
                    'open source software'
                  )}
                  className="mt-1 block w-full rounded-lg border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>
              <button
                type="button"
                onClick={runWebsearchTest}
                disabled={testing}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {testing ? (
                  <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white inline-block" />
                ) : (
                  <Icon name="SignalIcon" className="w-5 h-5" />
                )}
                {testing
                  ? t('admin.providers.websearchTest.running', 'Testing...')
                  : t('admin.providers.websearchTest.run', 'Run Test')}
              </button>
            </div>

            {testResult && (
              <div className="mt-4">
                <WebsearchTestResult result={testResult} />
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title="Unsaved Changes"
        message="You have unsaved changes. Leave anyway?"
        confirmLabel="Leave"
        denyLabel="Stay"
        danger={false}
        onConfirm={() => blocker.proceed?.()}
        onDeny={() => blocker.reset?.()}
      />
    </div>
  );
}

export default AdminProviderEditPage;
