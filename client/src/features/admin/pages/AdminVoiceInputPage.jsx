import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

const DEFAULT_SPEECH = {
  realtime: { enabled: false, url: 'ws://localhost:8080/v1/realtime', model: '', apiKey: '' },
  azure: { enabled: false, host: '', region: '' }
};

/**
 * Admin page for configuring voice-input / speech-to-text backends stored in
 * platform.json under `speech`:
 *   - vLLM Realtime (server-proxied, e.g. Voxtral) — fully managed here.
 *   - Azure Speech — platform-level host/region defaults. The subscription KEY
 *     is provided via the VITE_AZURE_SUBSCRIPTION_ID env var, not stored here.
 */
function AdminVoiceInputPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState(DEFAULT_SPEECH);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const platform = response.data || {};
      const speech = platform.speech || {};
      setConfig({
        realtime: { ...DEFAULT_SPEECH.realtime, ...(speech.realtime || {}) },
        azure: { ...DEFAULT_SPEECH.azure, ...(speech.azure || {}) }
      });
      setMessage('');
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message || t('admin.voiceInput.loadError', 'Failed to load voice input settings')
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage('');
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const platform = response.data || {};
      platform.speech = {
        ...(platform.speech || {}),
        realtime: config.realtime,
        azure: config.azure
      };
      await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: platform });
      setMessage({
        type: 'success',
        text: t('admin.voiceInput.saveSuccess', 'Voice input settings saved.')
      });
      // Reload so the API key shows its redacted state again.
      await loadConfig();
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error.message || t('admin.voiceInput.saveError', 'Failed to save voice input settings')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTestRealtime = async () => {
    try {
      setTesting(true);
      setTestResult(null);
      const response = await makeAdminApiCall('/admin/voice/realtime/test', {
        method: 'POST',
        body: {
          url: config.realtime.url,
          model: config.realtime.model,
          apiKey: config.realtime.apiKey
        }
      });
      setTestResult(response.data || { ok: false, message: 'No response' });
    } catch (error) {
      setTestResult({ ok: false, message: error.message || 'Test request failed' });
    } finally {
      setTesting(false);
    }
  };

  const setRealtime = (field, value) => {
    setTestResult(null);
    setConfig(prev => ({ ...prev, realtime: { ...prev.realtime, [field]: value } }));
  };
  const setAzure = (field, value) =>
    setConfig(prev => ({ ...prev, azure: { ...prev.azure, [field]: value } }));

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <p className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
          </div>
        </div>
      </div>
    );
  }

  const inputClass =
    'mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm';
  const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <div className="flex items-start mb-2">
            <Icon name="microphone" className="w-8 h-8 mr-3 text-blue-500 flex-shrink-0" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.voiceInput.title', 'Voice Input (Speech-to-Text)')}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.voiceInput.description',
                  'Configure the speech-to-text backends available to apps. Enable a backend here, then select it per app under the app editor’s Speech Recognition Service.'
                )}
              </p>
            </div>
          </div>
        </div>

        {message && (
          <div
            className={`p-4 rounded-lg ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
            }`}
          >
            {message.text}
          </div>
        )}

        {/* vLLM Realtime */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.voiceInput.realtime.title', 'vLLM Realtime (server-proxied)')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.voiceInput.realtime.description',
                'Streams microphone audio through the iHub server to a vLLM realtime endpoint (e.g. Voxtral). The URL and API key stay on the server. Select "vLLM Realtime" as an app’s Speech Recognition Service to use it.'
              )}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={!!config.realtime.enabled}
              onChange={e => setRealtime('enabled', e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            {t('admin.voiceInput.realtime.enabled', 'Enable vLLM realtime transcription')}
          </label>

          <div>
            <label className={labelClass} htmlFor="realtime-url">
              {t('admin.voiceInput.realtime.url', 'Realtime WebSocket URL')}
            </label>
            <input
              id="realtime-url"
              type="text"
              value={config.realtime.url || ''}
              onChange={e => setRealtime('url', e.target.value)}
              placeholder="ws://localhost:8080/v1/realtime"
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="realtime-model">
              {t('admin.voiceInput.realtime.model', 'Model')}
            </label>
            <input
              id="realtime-model"
              type="text"
              value={config.realtime.model || ''}
              onChange={e => setRealtime('model', e.target.value)}
              placeholder="mistralai/Voxtral-Mini-4B-Realtime-2602"
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="realtime-apikey">
              {t('admin.voiceInput.realtime.apiKey', 'API Key (optional)')}
            </label>
            <input
              id="realtime-apikey"
              type="password"
              value={config.realtime.apiKey || ''}
              onChange={e => setRealtime('apiKey', e.target.value)}
              autoComplete="new-password"
              placeholder={t('admin.voiceInput.realtime.apiKeyPlaceholder', 'Leave blank if none')}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.voiceInput.realtime.apiKeyHint',
                'Stored encrypted at rest. Local vLLM usually needs no key. A shown value of ***REDACTED*** means a key is already set — leave it to keep it.'
              )}
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-gray-100 dark:border-gray-700">
            <button
              type="button"
              onClick={handleTestRealtime}
              disabled={testing || !config.realtime.url}
              className="inline-flex items-center px-3 py-2 rounded-md border border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 text-sm font-medium hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-50"
            >
              {testing
                ? t('admin.voiceInput.realtime.testing', 'Testing…')
                : t('admin.voiceInput.realtime.test', 'Test connection')}
            </button>
            {testResult && (
              <span
                className={`text-sm flex items-center gap-1 ${
                  testResult.ok
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                <Icon
                  name={testResult.ok ? 'check-circle' : 'clearCircle'}
                  className="w-4 h-4 flex-shrink-0"
                />
                {testResult.message}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.voiceInput.realtime.testHint',
              'Tests connectivity from the iHub server to the vLLM realtime endpoint using the values above (the saved key is used when the field shows ***REDACTED***).'
            )}
          </p>
        </div>

        {/* Azure */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.voiceInput.azure.title', 'Azure Speech')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.voiceInput.azure.description',
                'Azure Cognitive Services Speech runs in the browser. These platform-level defaults are used when an app does not set its own host. The subscription key is provided via the VITE_AZURE_SUBSCRIPTION_ID environment variable and is not stored here.'
              )}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={!!config.azure.enabled}
              onChange={e => setAzure('enabled', e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            {t('admin.voiceInput.azure.enabled', 'Enable Azure Speech')}
          </label>

          <div>
            <label className={labelClass} htmlFor="azure-host">
              {t('admin.voiceInput.azure.host', 'Default host / endpoint')}
            </label>
            <input
              id="azure-host"
              type="url"
              value={config.azure.host || ''}
              onChange={e => setAzure('host', e.target.value)}
              placeholder="https://westeurope.stt.speech.microsoft.com"
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="azure-region">
              {t('admin.voiceInput.azure.region', 'Region (optional)')}
            </label>
            <input
              id="azure-region"
              type="text"
              value={config.azure.region || ''}
              onChange={e => setAzure('region', e.target.value)}
              placeholder="westeurope"
              className={inputClass}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AdminVoiceInputPage;
