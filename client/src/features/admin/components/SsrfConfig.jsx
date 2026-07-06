import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

function SsrfConfig() {
  const { t } = useTranslation();
  const [allowedHosts, setAllowedHosts] = useState([]);
  const [newHost, setNewHost] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await makeAdminApiCall('/admin/ssrf/config', { method: 'GET' });
        setAllowedHosts(
          Array.isArray(response.data.allowedHosts) ? response.data.allowedHosts : []
        );
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text:
            error.message ||
            t('admin.system.ssrf.configLoadError', 'Failed to load SSRF configuration')
        });
      } finally {
        setLoading(false);
      }
    };
    fetchConfig();
  }, [t]);

  const handleAddHost = () => {
    const trimmed = newHost.trim();
    if (!trimmed) return;
    if (!allowedHosts.includes(trimmed)) {
      setAllowedHosts(prev => [...prev, trimmed]);
    }
    setNewHost('');
  };

  const handleRemoveHost = host => {
    setAllowedHosts(prev => prev.filter(h => h !== host));
  };

  const handleKeyPress = e => {
    if (e.key === 'Enter') handleAddHost();
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      await makeAdminApiCall('/admin/ssrf/config', {
        method: 'PUT',
        body: { allowedHosts }
      });
      setMessage({
        type: 'success',
        text: t('admin.system.ssrf.configSaved', 'SSRF allowlist saved successfully')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message ||
          t('admin.system.ssrf.configSaveError', 'Failed to save SSRF configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
          {t('admin.system.ssrf.title', 'SSRF Allowlist')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <div className="flex items-start mb-4">
        <Icon name="ShieldCheckIcon" className="w-6 h-6 mr-2 text-blue-500 flex-shrink-0" />
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.system.ssrf.title', 'SSRF Allowlist')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.system.ssrf.description',
              'Allow outbound HTTP calls (OpenAPI tools, MCP servers, web tools) to reach intentionally internal services even when their hostname resolves to a private IP.'
            )}
          </p>
        </div>
      </div>

      {/* Security Warning */}
      <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
        <div className="flex">
          <Icon
            name="ExclamationTriangleIcon"
            className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 mr-3 flex-shrink-0"
          />
          <div>
            <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-300">
              {t('admin.system.ssrf.securityWarning', 'Security Warning')}
            </h4>
            <p className="text-sm text-yellow-700 dark:text-yellow-400 mt-1">
              {t(
                'admin.system.ssrf.securityWarningDesc',
                'Every hostname added here can be reached by tools and MCP servers even if it resolves to an internal IP. Only add hosts you control and trust. Patterns like *.example.com match every subdomain.'
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Message Display */}
      {message && (
        <div
          className={`p-4 rounded-md mb-4 ${
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

      {/* Add Host Input */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={newHost}
          onChange={e => setNewHost(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={t(
            'admin.system.ssrf.hostPlaceholder',
            '*.intrafind.io, api.internal.company.com'
          )}
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm"
        />
        <button
          onClick={handleAddHost}
          disabled={!newHost.trim()}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          <Icon name="PlusIcon" className="w-4 h-4 mr-1" />
          {t('admin.system.ssrf.addHost', 'Add host')}
        </button>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        {t(
          'admin.system.ssrf.patternHelp',
          'Supported patterns: exact hostname (api.example.com), wildcard (*.example.com), subdomain (.example.com).'
        )}
      </p>

      {/* Host List */}
      {allowedHosts.length > 0 ? (
        <div className="space-y-2 mb-6">
          {allowedHosts.map(host => (
            <div
              key={host}
              className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-md"
            >
              <div className="flex items-center">
                <Icon
                  name="GlobeAltIcon"
                  className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2"
                />
                <span className="text-sm text-gray-900 dark:text-gray-100 font-mono">{host}</span>
              </div>
              <button
                onClick={() => handleRemoveHost(host)}
                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium"
              >
                {t('admin.system.ssrf.removeHost', 'Remove')}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-md text-center mb-6">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.system.ssrf.noHosts',
              'No hosts allowed. Outbound calls to private/internal IPs are blocked.'
            )}
          </p>
        </div>
      )}

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
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
              {t('admin.system.ssrf.savingConfig', 'Saving…')}
            </>
          ) : (
            <>
              <Icon name="CheckIcon" className="w-4 h-4 mr-2" />
              {t('admin.system.ssrf.saveConfig', 'Save allowlist')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default SsrfConfig;
