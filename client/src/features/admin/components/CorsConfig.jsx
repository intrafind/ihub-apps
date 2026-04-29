import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'];
const DEFAULT_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-Forwarded-User',
  'X-Forwarded-Groups',
  'Accept',
  'Origin',
  'Cache-Control',
  'X-File-Name'
];

function CorsConfig() {
  const { t } = useTranslation();
  const [config, setConfig] = useState({
    origin: [],
    credentials: true,
    maxAge: 86400,
    methods: DEFAULT_METHODS,
    allowedHeaders: DEFAULT_HEADERS
  });
  const [newOrigin, setNewOrigin] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const fetchCorsConfig = async () => {
      try {
        const response = await makeAdminApiCall('/admin/cors/config', { method: 'GET' });
        setConfig({
          origin: Array.isArray(response.data.origin) ? response.data.origin : [],
          credentials:
            typeof response.data.credentials === 'boolean' ? response.data.credentials : true,
          maxAge: typeof response.data.maxAge === 'number' ? response.data.maxAge : 86400,
          methods: Array.isArray(response.data.methods) ? response.data.methods : DEFAULT_METHODS,
          allowedHeaders: Array.isArray(response.data.allowedHeaders)
            ? response.data.allowedHeaders
            : DEFAULT_HEADERS
        });
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text: error.message || t('admin.cors.loadError', 'Failed to load CORS configuration')
        });
      } finally {
        setLoading(false);
      }
    };

    fetchCorsConfig();
  }, [t]);

  const handleAddOrigin = () => {
    const trimmed = newOrigin.trim();
    if (!trimmed) return;
    if (!config.origin.includes(trimmed)) {
      setConfig(prev => ({ ...prev, origin: [...prev.origin, trimmed] }));
    }
    setNewOrigin('');
  };

  const handleRemoveOrigin = originToRemove => {
    setConfig(prev => ({ ...prev, origin: prev.origin.filter(o => o !== originToRemove) }));
  };

  const handleKeyPress = e => {
    if (e.key === 'Enter') handleAddOrigin();
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    setMessage('');
    try {
      await makeAdminApiCall('/admin/cors/config', { method: 'PUT', data: config });
      setMessage({
        type: 'success',
        text: t('admin.cors.saved', 'CORS configuration saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.cors.saveError', 'Failed to save CORS configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
          {t('admin.cors.title', 'CORS Configuration')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <div className="flex items-start mb-6">
        <Icon name="GlobeAltIcon" className="w-6 h-6 mr-2 text-blue-500 flex-shrink-0" />
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.cors.title', 'CORS Configuration')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.cors.description',
              'Configure which external origins (web apps, browser extensions, mobile apps) are allowed to make requests to this server.'
            )}
          </p>
        </div>
      </div>

      {/* Message Display */}
      {message && (
        <div
          className={`p-4 rounded-md mb-6 ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
          }`}
        >
          <div className="flex">
            <Icon
              name={message.type === 'success' ? 'CheckCircleIcon' : 'ExclamationCircleIcon'}
              className={`w-5 h-5 mt-0.5 mr-3 ${
                message.type === 'success'
                  ? 'text-green-500 dark:text-green-400'
                  : 'text-red-500 dark:text-red-400'
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

      {/* Allowed Origins */}
      <div className="mb-6">
        <h3 className="text-md font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {t('admin.cors.allowedOrigins', 'Allowed Origins')}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          {t(
            'admin.cors.allowedOriginsDesc',
            'Add origins that are permitted to access this API. Leave empty to block all cross-origin requests.'
          )}
        </p>

        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newOrigin}
            onChange={e => setNewOrigin(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={t(
              'admin.cors.originPlaceholder',
              'https://example.com or chrome-extension://abc123...'
            )}
            className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm"
          />
          <button
            onClick={handleAddOrigin}
            disabled={!newOrigin.trim()}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            <Icon name="PlusIcon" className="w-4 h-4 mr-1" />
            {t('admin.cors.addOrigin', 'Add Origin')}
          </button>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          {t(
            'admin.cors.envVarHint',
            'Tip: You can also use the ALLOWED_ORIGINS environment variable (comma-separated) for dynamic configuration.'
          )}
        </p>

        {config.origin.length > 0 ? (
          <div className="space-y-2">
            {config.origin.map((origin, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-md"
              >
                <div className="flex items-center min-w-0">
                  <Icon
                    name="GlobeAltIcon"
                    className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2 flex-shrink-0"
                  />
                  <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                    {origin}
                  </span>
                </div>
                <button
                  onClick={() => handleRemoveOrigin(origin)}
                  className="ml-3 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium flex-shrink-0"
                >
                  {t('common.remove', 'Remove')}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-md text-center">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.cors.noOrigins',
                'No origins configured — cross-origin requests are blocked.'
              )}
            </p>
          </div>
        )}
      </div>

      {/* Credentials */}
      <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
        <div className="flex items-start">
          <div className="flex-1">
            <label
              htmlFor="corsCredentials"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.cors.credentials', 'Allow Credentials')}
            </label>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.cors.credentialsDesc',
                'Allow cross-origin requests to include cookies and authorization headers. Required for authenticated API calls.'
              )}
            </p>
          </div>
          <div className="ml-4">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                id="corsCredentials"
                checked={config.credentials}
                onChange={e => setConfig(prev => ({ ...prev, credentials: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>
      </div>

      {/* Preflight Cache */}
      <div className="mb-6">
        <label
          htmlFor="corsMaxAge"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {t('admin.cors.maxAge', 'Preflight Cache (seconds)')}
        </label>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          {t(
            'admin.cors.maxAgeDesc',
            'How long browsers should cache preflight responses. Default is 86400 (24 hours).'
          )}
        </p>
        <input
          type="number"
          id="corsMaxAge"
          min="0"
          value={config.maxAge}
          onChange={e =>
            setConfig(prev => ({ ...prev, maxAge: parseInt(e.target.value, 10) || 0 }))
          }
          className="w-40 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm"
        />
      </div>

      {/* Allowed Methods */}
      <div className="mb-6">
        <label
          htmlFor="corsMethods"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {t('admin.cors.methods', 'Allowed Methods')}
        </label>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          {t('admin.cors.methodsDesc', 'Comma-separated list of HTTP methods to allow.')}
        </p>
        <input
          type="text"
          id="corsMethods"
          value={config.methods.join(', ')}
          onChange={e =>
            setConfig(prev => ({
              ...prev,
              methods: e.target.value
                .split(',')
                .map(m => m.trim().toUpperCase())
                .filter(m => m)
            }))
          }
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm"
        />
      </div>

      {/* Allowed Headers */}
      <div className="mb-6">
        <label
          htmlFor="corsAllowedHeaders"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {t('admin.cors.allowedHeaders', 'Allowed Headers')}
        </label>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          {t(
            'admin.cors.allowedHeadersDesc',
            'Comma-separated list of HTTP request headers clients are allowed to send.'
          )}
        </p>
        <textarea
          id="corsAllowedHeaders"
          rows={3}
          value={config.allowedHeaders.join(', ')}
          onChange={e =>
            setConfig(prev => ({
              ...prev,
              allowedHeaders: e.target.value
                .split(',')
                .map(h => h.trim())
                .filter(h => h)
            }))
          }
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm font-mono"
        />
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSaveConfig}
          disabled={saving}
          className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white ${
            saving
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
          }`}
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
              {t('admin.cors.saving', 'Saving...')}
            </>
          ) : (
            <>
              <Icon name="CheckIcon" className="w-4 h-4 mr-2" />
              {t('admin.cors.save', 'Save Configuration')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default CorsConfig;
