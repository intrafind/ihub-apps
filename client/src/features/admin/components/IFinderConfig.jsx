import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

const ALGORITHM_OPTIONS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'];

const JWT_SUBJECT_OPTIONS = [
  { value: 'email', label: 'Email address' },
  { value: 'username', label: 'Username' },
  { value: 'domain\\username', label: 'Domain\\Username (NTLM-style)' },
  { value: 'custom', label: 'Custom template' }
];

function IFinderConfig() {
  const { t } = useTranslation();
  const [iFinderConfig, setIFinderConfig] = useState({
    enabled: false,
    baseUrl: '',
    privateKey: '',
    algorithm: 'RS256',
    issuer: 'ihub-apps',
    audience: 'ifinder-api',
    tokenExpirationSeconds: 3600,
    defaultScope: 'fa_index_read',
    jwtSubjectField: 'email'
  });
  const [iAssistantConfig, setIAssistantConfig] = useState({
    baseUrl: '',
    defaultProfileId: '',
    timeout: 60000
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState({ iFinder: false, iAssistant: false });
  const [testResults, setTestResults] = useState({ iFinder: null, iAssistant: null });
  const [message, setMessage] = useState('');

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await makeAdminApiCall('/admin/configs/platform', {
          method: 'GET'
        });
        const iFinder = response.data.iFinder || {
          enabled: false,
          baseUrl: '',
          privateKey: '',
          algorithm: 'RS256',
          issuer: 'ihub-apps',
          audience: 'ifinder-api',
          tokenExpirationSeconds: 3600,
          defaultScope: 'fa_index_read',
          jwtSubjectField: 'email'
        };
        const iAssistant = response.data.iAssistant || {
          baseUrl: '',
          defaultProfileId: '',
          timeout: 60000
        };
        setIFinderConfig(iFinder);
        setIAssistantConfig(iAssistant);
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text:
            error.message || t('admin.iFinder.loadError', 'Failed to load iFinder configuration')
        });
      } finally {
        setLoading(false);
      }
    };

    fetchConfig();
  }, [t]);

  const handleToggleEnabled = e => {
    setIFinderConfig(prev => ({
      ...prev,
      enabled: e.target.checked
    }));
  };

  const handleIFinderChange = (field, value) => {
    setIFinderConfig(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleIAssistantChange = (field, value) => {
    setIAssistantConfig(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');

    try {
      const response = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });

      const updatedPlatformConfig = {
        ...response.data,
        iFinder: iFinderConfig,
        iAssistant: iAssistantConfig
      };

      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        data: updatedPlatformConfig
      });

      setMessage({
        type: 'success',
        text: t('admin.iFinder.saveSuccess', 'iFinder configuration saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.iFinder.saveError', 'Failed to save iFinder configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTestIFinder = async () => {
    setTesting(prev => ({ ...prev, iFinder: true }));
    setTestResults(prev => ({ ...prev, iFinder: null }));
    setMessage('');

    try {
      const response = await makeAdminApiCall('/admin/integrations/ifinder/_test', {
        method: 'POST'
      });

      setTestResults(prev => ({ ...prev, iFinder: response.data }));

      if (response.data.success) {
        setMessage({
          type: 'success',
          text: t('admin.iFinder.testSuccess', 'Connection test successful')
        });
      } else {
        setMessage({
          type: 'error',
          text: response.data.message || t('admin.iFinder.testFailed', 'Connection test failed')
        });
      }
    } catch (error) {
      setTestResults(prev => ({
        ...prev,
        iFinder: { success: false, message: error.message }
      }));
      setMessage({
        type: 'error',
        text: error.message || t('admin.iFinder.testFailed', 'Connection test failed')
      });
    } finally {
      setTesting(prev => ({ ...prev, iFinder: false }));
    }
  };

  const handleTestIAssistant = async () => {
    setTesting(prev => ({ ...prev, iAssistant: true }));
    setTestResults(prev => ({ ...prev, iAssistant: null }));
    setMessage('');

    try {
      const response = await makeAdminApiCall('/admin/integrations/iassistant/_test', {
        method: 'POST'
      });

      setTestResults(prev => ({ ...prev, iAssistant: response.data }));

      if (response.data.success) {
        setMessage({
          type: 'success',
          text: t('admin.iFinder.testSuccess', 'Connection test successful')
        });
      } else {
        setMessage({
          type: 'error',
          text: response.data.message || t('admin.iFinder.testFailed', 'Connection test failed')
        });
      }
    } catch (error) {
      setTestResults(prev => ({
        ...prev,
        iAssistant: { success: false, message: error.message }
      }));
      setMessage({
        type: 'error',
        text: error.message || t('admin.iFinder.testFailed', 'Connection test failed')
      });
    } finally {
      setTesting(prev => ({ ...prev, iAssistant: false }));
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-start space-x-4">
        <div className="flex-shrink-0 mt-1">
          <div className="p-3 rounded-full bg-indigo-100 dark:bg-indigo-900/50">
            <Icon name="search" size="lg" className="text-indigo-600 dark:text-indigo-400" />
          </div>
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t('admin.iFinder.title', 'iFinder Integration')}
          </h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {t(
              'admin.iFinder.subtitle',
              'Configure your iFinder instance connection and iAssistant RAG settings.'
            )}
          </p>

          {/* Info Card */}
          <div className="bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-md p-4 mb-4">
            <div className="flex">
              <Icon name="info" size="md" className="text-indigo-500 mt-0.5 mr-3" />
              <div>
                <h4 className="text-sm font-medium text-indigo-800 dark:text-indigo-200">
                  {t('admin.iFinder.info.title', 'iFinder JWT Authentication')}
                </h4>
                <p className="text-sm text-indigo-700 dark:text-indigo-300 mt-1">
                  {t(
                    'admin.iFinder.info.description',
                    'The private key is used to sign JWT tokens for API authentication. iAssistant settings configure the RAG question-answering service built on iFinder infrastructure.'
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Enable/Disable Toggle */}
          <div className="flex items-center mb-6">
            <input
              type="checkbox"
              id="iFinderEnabled"
              checked={iFinderConfig.enabled}
              onChange={handleToggleEnabled}
              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
            />
            <label
              htmlFor="iFinderEnabled"
              className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
            >
              {iFinderConfig.enabled
                ? t('admin.iFinder.enabled', 'iFinder integration enabled')
                : t('admin.iFinder.disabled', 'iFinder integration disabled')}
            </label>
          </div>

          {/* Configuration Fields */}
          {iFinderConfig.enabled && (
            <>
              {/* iFinder Connection Section */}
              <h4 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-3">
                {t('admin.iFinder.connectionSection', 'iFinder Connection')}
              </h4>
              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.iFinder.baseUrl', 'iFinder Base URL')} *
                  </label>
                  <input
                    type="url"
                    value={iFinderConfig.baseUrl}
                    onChange={e => handleIFinderChange('baseUrl', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    placeholder="https://dama.dev.intrafind.io"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('admin.iFinder.baseUrlHelp', 'Your iFinder instance URL')}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.iFinder.privateKey', 'Private Key (PEM)')} *
                  </label>
                  <textarea
                    value={iFinderConfig.privateKey}
                    onChange={e => handleIFinderChange('privateKey', e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono text-sm"
                    placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.iFinder.privateKeyHelp',
                      'RSA/EC private key in PEM format for signing JWT tokens'
                    )}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.iFinder.algorithm', 'JWT Algorithm')}
                    </label>
                    <select
                      value={iFinderConfig.algorithm}
                      onChange={e => handleIFinderChange('algorithm', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    >
                      {ALGORITHM_OPTIONS.map(alg => (
                        <option key={alg} value={alg}>
                          {alg}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.iFinder.tokenExpiration', 'Token Expiration (seconds)')}
                    </label>
                    <input
                      type="number"
                      value={iFinderConfig.tokenExpirationSeconds}
                      onChange={e =>
                        handleIFinderChange(
                          'tokenExpirationSeconds',
                          parseInt(e.target.value, 10) || 3600
                        )
                      }
                      min={60}
                      max={86400}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.iFinder.issuer', 'JWT Issuer')}
                    </label>
                    <input
                      type="text"
                      value={iFinderConfig.issuer}
                      onChange={e => handleIFinderChange('issuer', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                      placeholder="ihub-apps"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.iFinder.audience', 'JWT Audience')}
                    </label>
                    <input
                      type="text"
                      value={iFinderConfig.audience}
                      onChange={e => handleIFinderChange('audience', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                      placeholder="ifinder-api"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.iFinder.defaultScope', 'Default Scope')}
                  </label>
                  <input
                    type="text"
                    value={iFinderConfig.defaultScope}
                    onChange={e => handleIFinderChange('defaultScope', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    placeholder="fa_index_read"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.iFinder.jwtSubjectField', 'JWT Subject Field')}
                  </label>
                  <select
                    value={
                      JWT_SUBJECT_OPTIONS.some(o => o.value === iFinderConfig.jwtSubjectField)
                        ? iFinderConfig.jwtSubjectField
                        : 'custom'
                    }
                    onChange={e => {
                      const value = e.target.value;
                      if (value === 'custom') {
                        handleIFinderChange('jwtSubjectField', '${email}');
                      } else {
                        handleIFinderChange('jwtSubjectField', value);
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  >
                    {JWT_SUBJECT_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {t(`admin.iFinder.jwtSubject.${opt.value}`, opt.label)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.iFinder.jwtSubjectFieldHelp',
                      'Controls the "sub" claim in the iFinder JWT token. Choose which user field identifies the user.'
                    )}
                  </p>
                </div>

                {!JWT_SUBJECT_OPTIONS.some(o => o.value === iFinderConfig.jwtSubjectField) && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.iFinder.jwtSubjectTemplate', 'Custom Subject Template')}
                    </label>
                    <input
                      type="text"
                      value={iFinderConfig.jwtSubjectField}
                      onChange={e => handleIFinderChange('jwtSubjectField', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono text-sm"
                      placeholder="${domain}\${username}"
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.iFinder.jwtSubjectTemplateHelp',
                        'Available placeholders: ${email}, ${username}, ${domain}, ${id}, ${name}'
                      )}
                    </p>
                  </div>
                )}
              </div>

              {/* iAssistant Settings Section */}
              <h4 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-3 mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                {t('admin.iFinder.iAssistantSection', 'iAssistant Settings')}
              </h4>
              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.iFinder.iAssistantBaseUrl', 'iAssistant Base URL')}
                  </label>
                  <input
                    type="url"
                    value={iAssistantConfig.baseUrl}
                    onChange={e => handleIAssistantChange('baseUrl', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    placeholder="https://dama.dev.intrafind.io"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.iFinder.iAssistantBaseUrlHelp',
                      'Override if iAssistant runs on a different URL than iFinder'
                    )}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.iFinder.defaultProfileId', 'Default Profile ID')}
                    </label>
                    <input
                      type="text"
                      value={iAssistantConfig.defaultProfileId}
                      onChange={e => handleIAssistantChange('defaultProfileId', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                      placeholder="c2VhcmNocHJvZmlsZS1zdGFuZGFyZA=="
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.iFinder.defaultProfileIdHelp',
                        'Search profile ID (plain text or base64 encoded)'
                      )}
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('admin.iFinder.timeout', 'Request Timeout (ms)')}
                    </label>
                    <input
                      type="number"
                      value={iAssistantConfig.timeout}
                      onChange={e =>
                        handleIAssistantChange('timeout', parseInt(e.target.value, 10) || 60000)
                      }
                      min={5000}
                      max={300000}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Test Results Display */}
          {(testResults.iFinder || testResults.iAssistant) && (
            <div className="mb-4 p-4 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
              <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                {t('admin.iFinder.testResults.title', 'Test Results')}
              </h4>
              {testResults.iFinder && (
                <div className="mb-2">
                  <div className="flex items-center mb-1">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300 mr-2">
                      iFinder:
                    </span>
                    <span
                      className={`text-sm font-medium ${
                        testResults.iFinder.success
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {testResults.iFinder.success
                        ? t('admin.iFinder.testResults.success', 'Success')
                        : t('admin.iFinder.testResults.failed', 'Failed')}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    {testResults.iFinder.message}
                  </p>
                  {testResults.iFinder.details && (
                    <pre className="mt-2 text-xs text-gray-600 dark:text-gray-400 overflow-x-auto">
                      {JSON.stringify(testResults.iFinder.details, null, 2)}
                    </pre>
                  )}
                </div>
              )}
              {testResults.iAssistant && (
                <div>
                  <div className="flex items-center mb-1">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300 mr-2">
                      iAssistant:
                    </span>
                    <span
                      className={`text-sm font-medium ${
                        testResults.iAssistant.success
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {testResults.iAssistant.success
                        ? t('admin.iFinder.testResults.success', 'Success')
                        : t('admin.iFinder.testResults.failed', 'Failed')}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    {testResults.iAssistant.message}
                  </p>
                  {testResults.iAssistant.details && (
                    <pre className="mt-2 text-xs text-gray-600 dark:text-gray-400 overflow-x-auto">
                      {JSON.stringify(testResults.iAssistant.details, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Messages */}
          {message && (
            <div
              className={`p-4 rounded-md mb-4 ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
              }`}
            >
              <div className="flex">
                <Icon
                  name={message.type === 'success' ? 'check' : 'warning'}
                  size="md"
                  className={`mt-0.5 mr-3 ${
                    message.type === 'success' ? 'text-green-500' : 'text-red-500'
                  }`}
                />
                <p
                  className={`text-sm ${
                    message.type === 'success'
                      ? 'text-green-700 dark:text-green-300'
                      : 'text-red-700 dark:text-red-300'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            {/* Save Button */}
            <button
              onClick={handleSave}
              disabled={saving}
              className={`
                inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium
                rounded-md shadow-sm text-white
                ${
                  saving
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
                }
              `}
            >
              {saving ? (
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
                  {t('admin.iFinder.saving', 'Saving...')}
                </>
              ) : (
                <>
                  <Icon name="save" size="md" className="mr-2" />
                  {t('admin.iFinder.save', 'Save iFinder Configuration')}
                </>
              )}
            </button>

            {/* Test iFinder Button */}
            {iFinderConfig.enabled && (
              <button
                onClick={handleTestIFinder}
                disabled={testing.iFinder}
                className={`
                  inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600
                  text-sm font-medium rounded-md shadow-sm
                  ${
                    testing.iFinder
                      ? 'bg-gray-400 text-white cursor-not-allowed'
                      : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
                  }
                `}
              >
                {testing.iFinder ? (
                  <>
                    <svg
                      className="animate-spin -ml-1 mr-3 h-4 w-4"
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
                    {t('admin.iFinder.testing', 'Testing...')}
                  </>
                ) : (
                  <>
                    <Icon name="check" size="md" className="mr-2" />
                    {t('admin.iFinder.testIFinder', 'Test iFinder')}
                  </>
                )}
              </button>
            )}

            {/* Test iAssistant Button */}
            {iFinderConfig.enabled && (
              <button
                onClick={handleTestIAssistant}
                disabled={testing.iAssistant}
                className={`
                  inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600
                  text-sm font-medium rounded-md shadow-sm
                  ${
                    testing.iAssistant
                      ? 'bg-gray-400 text-white cursor-not-allowed'
                      : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
                  }
                `}
              >
                {testing.iAssistant ? (
                  <>
                    <svg
                      className="animate-spin -ml-1 mr-3 h-4 w-4"
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
                    {t('admin.iFinder.testing', 'Testing...')}
                  </>
                ) : (
                  <>
                    <Icon name="check" size="md" className="mr-2" />
                    {t('admin.iFinder.testIAssistant', 'Test iAssistant')}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default IFinderConfig;
