import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { fetchTranscriptionModels } from '../../../api/endpoints/models';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  SPEECH_SERVICES,
  getSpeechServiceLabel,
  isSpeechServiceEnabled
} from '../../voice/utils/speechService';
import VoiceInputTestPanel from '../components/voice/VoiceInputTestPanel';

const DEFAULT_SPEECH = {
  defaultService: 'browser',
  transcription: { defaultModelId: '' },
  realtime: { enabled: false, url: 'ws://localhost:8080/v1/realtime', model: '', apiKey: '' },
  azure: { enabled: false, host: '', region: '', subscriptionKey: '' }
};

const toFormSpeech = (speech = {}) => ({
  defaultService: speech.defaultService || DEFAULT_SPEECH.defaultService,
  transcription: { ...DEFAULT_SPEECH.transcription, ...(speech.transcription || {}) },
  realtime: { ...DEFAULT_SPEECH.realtime, ...(speech.realtime || {}) },
  azure: { ...DEFAULT_SPEECH.azure, ...(speech.azure || {}) }
});

/**
 * The saved config in the shape GET /api/configs/platform gives the client, so
 * the test panel builds recognizers exactly like a chat does. A set key reads
 * back as ***REDACTED***, which is enough to know one is configured.
 */
const toPublicSpeech = speech => ({
  defaultService: speech.defaultService,
  transcription: { defaultModelId: speech.transcription.defaultModelId },
  realtime: { enabled: !!speech.realtime.enabled },
  azure: {
    enabled: !!speech.azure.enabled,
    host: speech.azure.host,
    region: speech.azure.region,
    keyConfigured: !!speech.azure.subscriptionKey
  }
});

/**
 * Admin page for voice input / speech-to-text, stored in platform.json under
 * `speech`:
 *   - Defaults — the dictation service and transcription model apps use unless
 *     they pick their own.
 *   - vLLM Realtime (server-proxied, e.g. Voxtral) — fully managed here.
 *   - Azure Speech — host/region plus the subscription key, which is stored
 *     encrypted server-side and brokered to the browser as a short-lived token.
 *   - Test panel — microphone, live dictation and record → transcribe checks.
 */
function AdminVoiceInputPage() {
  const { t, i18n } = useTranslation();
  const { refreshConfig } = usePlatformConfig();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState(DEFAULT_SPEECH);
  const [savedConfig, setSavedConfig] = useState(DEFAULT_SPEECH);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [azureTesting, setAzureTesting] = useState(false);
  const [azureTestResult, setAzureTestResult] = useState(null);
  const [transcriptionModels, setTranscriptionModels] = useState(null);

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    fetchTranscriptionModels()
      .then(list => active && setTranscriptionModels(Array.isArray(list) ? list : []))
      .catch(() => active && setTranscriptionModels([]));
    return () => {
      active = false;
    };
  }, []);

  // Read platform.speech into the form and the saved snapshot.
  const fetchSpeech = async () => {
    const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
    const speech = toFormSpeech((response.data || {}).speech);
    setConfig(speech);
    setSavedConfig(speech);
  };

  const loadConfig = async () => {
    try {
      setLoading(true);
      await fetchSpeech();
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
        defaultService: config.defaultService,
        transcription: { ...(platform.speech?.transcription || {}), ...config.transcription },
        realtime: config.realtime,
        azure: config.azure
      };
      await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: platform });
      // Re-read so the keys show their redacted state again. Not loadConfig():
      // it blanks the page while loading and clears the message, so the
      // success notice never showed and the test panel lost its state.
      await fetchSpeech();
      // Chats and the app editor see the new defaults without a page reload.
      refreshConfig();
      setMessage({
        type: 'success',
        text: t('admin.voiceInput.saveSuccess', 'Voice input settings saved.')
      });
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

  const handleTestAzure = async () => {
    try {
      setAzureTesting(true);
      setAzureTestResult(null);
      const response = await makeAdminApiCall('/admin/voice/azure/test', {
        method: 'POST',
        body: {
          region: config.azure.region,
          host: config.azure.host,
          subscriptionKey: config.azure.subscriptionKey
        }
      });
      setAzureTestResult(response.data || { ok: false, message: 'No response' });
    } catch (error) {
      setAzureTestResult({ ok: false, message: error.message || 'Test request failed' });
    } finally {
      setAzureTesting(false);
    }
  };

  const setRealtime = (field, value) => {
    setTestResult(null);
    setConfig(prev => ({ ...prev, realtime: { ...prev.realtime, [field]: value } }));
  };
  const setAzure = (field, value) => {
    setAzureTestResult(null);
    setConfig(prev => ({ ...prev, azure: { ...prev.azure, [field]: value } }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
            <p className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
          </div>
        </div>
      </div>
    );
  }

  const inputClass =
    'mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm';
  const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300';
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  const defaultServiceEnabled = isSpeechServiceEnabled(config.defaultService, config);
  const defaultModelId = config.transcription.defaultModelId;
  const defaultModelMissing =
    !!defaultModelId &&
    Array.isArray(transcriptionModels) &&
    !transcriptionModels.some(m => m.id === defaultModelId);

  const renderTestResult = result =>
    result && (
      <span
        className={`text-sm flex items-center gap-1 ${
          result.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
        }`}
      >
        <Icon name={result.ok ? 'check-circle' : 'clearCircle'} className="w-4 h-4 shrink-0" />
        {result.message}
      </span>
    );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
          <div className="flex items-start mb-2">
            <Icon name="microphone" className="w-8 h-8 mr-3 text-blue-500 shrink-0" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.voiceInput.title', 'Voice Input (Speech-to-Text)')}
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t(
                  'admin.voiceInput.description',
                  'Configure the speech-to-text backends and the defaults apps use. Apps follow the defaults unless they select a service or model of their own in the app editor.'
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

        {/* Platform-wide defaults */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.voiceInput.defaults.title', 'Defaults')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.voiceInput.defaults.description',
                'Used by every app that has no voice setting of its own (Speech Recognition Service "Platform default", no transcription model). Apps that select a service or model keep their choice.'
              )}
            </p>
          </div>

          <div>
            <label className={labelClass} htmlFor="default-service">
              {t('admin.voiceInput.defaults.service', 'Dictation service (microphone button)')}
            </label>
            <select
              id="default-service"
              value={config.defaultService}
              onChange={e => setConfig(prev => ({ ...prev, defaultService: e.target.value }))}
              className={inputClass}
            >
              {SPEECH_SERVICES.map(value => (
                <option key={value} value={value}>
                  {getSpeechServiceLabel(value, t)}
                  {!isSpeechServiceEnabled(value, config)
                    ? ` (${t('admin.voiceInput.notEnabled', 'not enabled')})`
                    : ''}
                </option>
              ))}
            </select>
            {!defaultServiceEnabled && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t(
                  'admin.voiceInput.defaults.serviceNotEnabled',
                  '{{service}} is not enabled below. Until it is, apps that follow the platform default use the browser.',
                  { service: getSpeechServiceLabel(config.defaultService, t) }
                )}
              </p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor="default-transcription-model">
              {t('admin.voiceInput.defaults.transcriptionModel', 'Transcription model (recording)')}
            </label>
            <select
              id="default-transcription-model"
              value={defaultModelId}
              onChange={e =>
                setConfig(prev => ({
                  ...prev,
                  transcription: { ...prev.transcription, defaultModelId: e.target.value }
                }))
              }
              className={inputClass}
            >
              <option value="">{t('admin.voiceInput.defaults.noModel', 'None')}</option>
              {defaultModelMissing && <option value={defaultModelId}>{defaultModelId}</option>}
              {(transcriptionModels || []).map(m => (
                <option key={m.id} value={m.id}>
                  {getLocalizedContent(m.name, i18n.language) || m.id}
                </option>
              ))}
            </select>
            <p
              className={`mt-1 text-xs ${
                defaultModelMissing
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {defaultModelMissing
                ? t(
                    'admin.voiceInput.defaults.modelUnavailable',
                    'This model is disabled or no longer exists, so recording fails in apps that rely on the default.'
                  )
                : t(
                    'admin.voiceInput.defaults.transcriptionModelHint',
                    'Used to transcribe recordings and audio/video uploads in apps that enable transcription without choosing a model.'
                  )}
            </p>
          </div>
        </div>

        {/* vLLM Realtime */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.voiceInput.realtime.title', 'vLLM Realtime (server-proxied)')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.voiceInput.realtime.description',
                'Streams microphone audio through the iHub server to a vLLM realtime endpoint (e.g. Voxtral). The URL and API key stay on the server. Make it the default above, or select "vLLM Realtime" as an app’s Speech Recognition Service.'
              )}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={!!config.realtime.enabled}
              onChange={e => setRealtime('enabled', e.target.checked)}
              className="rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
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
            {renderTestResult(testResult)}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.voiceInput.realtime.testHint',
              'Tests connectivity from the iHub server to the vLLM realtime endpoint using the values above (the saved key is used when the field shows ***REDACTED***).'
            )}
          </p>
        </div>

        {/* Azure */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.voiceInput.azure.title', 'Azure Speech')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.voiceInput.azure.description',
                'Azure Cognitive Services Speech runs in the browser via a short-lived token. The subscription key is stored encrypted on the server and exchanged for a token per session, so it never reaches the browser. Host/region are the defaults used when an app does not set its own host.'
              )}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={!!config.azure.enabled}
              onChange={e => setAzure('enabled', e.target.checked)}
              className="rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
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
              {t('admin.voiceInput.azure.region', 'Region')}
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

          <div>
            <label className={labelClass} htmlFor="azure-key">
              {t('admin.voiceInput.azure.subscriptionKey', 'Subscription Key')}
            </label>
            <input
              id="azure-key"
              type="password"
              value={config.azure.subscriptionKey || ''}
              onChange={e => setAzure('subscriptionKey', e.target.value)}
              autoComplete="new-password"
              placeholder={t(
                'admin.voiceInput.azure.subscriptionKeyPlaceholder',
                'Azure Speech key'
              )}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.voiceInput.azure.subscriptionKeyHint',
                'Stored encrypted at rest and never sent to the browser. A shown value of ***REDACTED*** means a key is already set — leave it to keep it. Leave it empty for an on-prem Azure Speech container, which needs no key — set its host above.'
              )}
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-gray-100 dark:border-gray-700">
            <button
              type="button"
              onClick={handleTestAzure}
              disabled={azureTesting}
              className="inline-flex items-center px-3 py-2 rounded-md border border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 text-sm font-medium hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-50"
            >
              {azureTesting
                ? t('admin.voiceInput.realtime.testing', 'Testing…')
                : t('admin.voiceInput.realtime.test', 'Test connection')}
            </button>
            {renderTestResult(azureTestResult)}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.voiceInput.azure.testHint',
              'Checks the key and region from the iHub server by requesting a token, using the values above. Speech recognition itself runs in the browser: use the live dictation test below.'
            )}
          </p>
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

        <VoiceInputTestPanel
          speech={toPublicSpeech(savedConfig)}
          models={transcriptionModels}
          dirty={dirty}
          t={t}
          language={i18n.language}
        />
      </div>
    </div>
  );
}

export default AdminVoiceInputPage;
