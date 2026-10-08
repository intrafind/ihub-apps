import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  fromDictationValue,
  getSpeechServiceLabel,
  toDictationValue
} from '../../voice/utils/speechService';
import VoiceInputTestPanel from '../components/voice/VoiceInputTestPanel';
import ReadAloudButton from '../../voice/components/ReadAloudButton';
import useReadAloudPlayback from '../../voice/hooks/useReadAloudPlayback';
import { stop as stopReadAloud } from '../../voice/utils/readAloud';

/** Playback id of the read-aloud test, apart from every chat message. */
const READ_ALOUD_TEST_ID = 'admin-read-aloud-test';

const DEFAULT_SPEECH = {
  defaultService: 'browser',
  dictation: { modelId: '' },
  transcription: { defaultModelId: '' },
  tts: { enabled: false, defaultModelId: '' },
  azure: { enabled: false, host: '', region: '', subscriptionKey: '' }
};

const toFormSpeech = (speech = {}) => ({
  defaultService: speech.defaultService || DEFAULT_SPEECH.defaultService,
  dictation: { ...DEFAULT_SPEECH.dictation, ...speech.dictation },
  transcription: { ...DEFAULT_SPEECH.transcription, ...speech.transcription },
  tts: { ...DEFAULT_SPEECH.tts, ...speech.tts },
  azure: { ...DEFAULT_SPEECH.azure, ...speech.azure }
});

/**
 * The saved config in the shape GET /api/configs/platform gives the client, so
 * the test panel builds recognizers exactly like a chat does. A set key reads
 * back as ***REDACTED***, which is enough to know one is configured.
 *
 * @param {object} speech Form-shaped speech config.
 * @param {Array|null} transcriptionModels Enabled transcription models.
 */
const toPublicSpeech = (speech, transcriptionModels) => ({
  defaultService: speech.defaultService,
  dictation: {
    modelId: speech.dictation.modelId,
    available: (transcriptionModels || []).some(m => m.id === speech.dictation.modelId)
  },
  transcription: { defaultModelId: speech.transcription.defaultModelId },
  tts: { enabled: !!speech.tts.enabled, defaultModelId: speech.tts.defaultModelId },
  azure: {
    enabled: !!speech.azure.enabled,
    host: speech.azure.host,
    region: speech.azure.region,
    keyConfigured: !!speech.azure.subscriptionKey
  }
});

/**
 * Admin page for voice, stored in platform.json under `speech`. It picks what
 * apps use unless they pick their own:
 *   - Voice input (the microphone button) — the browser, Azure Speech or any
 *     transcription model.
 *   - Transcription (record button, audio/video uploads) — a transcription model.
 *   - Read aloud — a text-to-speech model.
 * Model endpoints and keys live on the models (Admin → Models). Azure Speech is
 * no model, so its host/region and subscription key are set here; the key is
 * stored encrypted server-side and brokered to the browser as a short-lived
 * token. The test panel runs microphone, live dictation and record →
 * transcribe checks.
 */
function AdminVoiceInputPage() {
  const { t, i18n } = useTranslation();
  const { refreshConfig } = usePlatformConfig();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState(DEFAULT_SPEECH);
  const [savedConfig, setSavedConfig] = useState(DEFAULT_SPEECH);
  const [azureTesting, setAzureTesting] = useState(false);
  const [azureTestResult, setAzureTestResult] = useState(null);
  const [transcriptionModels, setTranscriptionModels] = useState(null);
  // Every TTS model, disabled ones included: the seeded Voxtral TTS model
  // ships disabled, and the picker says so instead of hiding it.
  const [ttsModels, setTtsModels] = useState(null);
  const [ttsSample, setTtsSample] = useState('');
  const readAloudTest = useReadAloudPlayback(READ_ALOUD_TEST_ID);

  useEffect(() => {
    void loadConfig();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  // The admin model list, not the public /api/models: that one is filtered by
  // the admin's own model permissions, and admin access does not imply them.
  useEffect(() => {
    let active = true;
    makeAdminApiCall('/admin/models', { method: 'GET' })
      .then(response => {
        if (!active) return;
        const models = Array.isArray(response.data) ? response.data : [];
        setTranscriptionModels(
          models.filter(m => m.modelType === 'transcription' && m.enabled !== false)
        );
        setTtsModels(models.filter(m => m.modelType === 'tts'));
      })
      .catch(() => {
        if (!active) return;
        setTranscriptionModels([]);
        setTtsModels([]);
      });
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
        ...platform.speech,
        defaultService: config.defaultService,
        dictation: { ...platform.speech?.dictation, ...config.dictation },
        transcription: { ...platform.speech?.transcription, ...config.transcription },
        tts: { ...platform.speech?.tts, ...config.tts },
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
      const result = response.data || { ok: false, message: 'No response' };
      setAzureTestResult({ ok: result.ok, message: describeAzureTest(result) });
    } catch (error) {
      setAzureTestResult({ ok: false, message: error.message || 'Test request failed' });
    } finally {
      setAzureTesting(false);
    }
  };

  // The Azure test answers with a stable code; unknown codes (an older
  // server) fall back to its English message.
  const describeAzureTest = result => {
    switch (result.code) {
      case 'token-issued':
        return t(
          'admin.voiceInput.azure.test.tokenIssued',
          'Key accepted: Azure issued a token for region "{{region}}".',
          { region: result.region }
        );
      case 'keyless':
        return t(
          'admin.voiceInput.azure.test.keyless',
          'No subscription key: keyless mode. Browsers connect straight to the host, so verify it with the live dictation test below.'
        );
      case 'not-configured':
        return t(
          'admin.voiceInput.azure.test.notConfigured',
          'Neither a subscription key nor a host is set. Azure cloud needs a key and region; an on-prem container needs a host.'
        );
      case 'invalid-key':
        return t(
          'admin.voiceInput.azure.test.invalidKey',
          'Azure rejected the key (HTTP 401): it is invalid or belongs to a different region.'
        );
      case 'token-failed':
        return t('admin.voiceInput.azure.test.tokenFailed', 'Token request failed: {{detail}}', {
          detail: result.message
        });
      default:
        return result.message;
    }
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
  const dictationModelId = config.defaultService === 'model' ? config.dictation.modelId : '';
  const dictationModelMissing =
    config.defaultService === 'model' &&
    Array.isArray(transcriptionModels) &&
    !transcriptionModels.some(m => m.id === dictationModelId);
  const modelName = model => getLocalizedContent(model.name, i18n.language) || model.id;
  const defaultModelId = config.transcription.defaultModelId;
  const defaultModelMissing =
    !!defaultModelId &&
    Array.isArray(transcriptionModels) &&
    !transcriptionModels.some(m => m.id === defaultModelId);
  const ttsModelId = config.tts.defaultModelId;
  const ttsModel = (ttsModels || []).find(m => m.id === ttsModelId);
  const ttsModelMissing = !!ttsModelId && Array.isArray(ttsModels) && !ttsModel;
  const ttsModelDisabled = !!ttsModel && ttsModel.enabled === false;
  const ttsSampleText =
    ttsSample.trim() ||
    t(
      'admin.voiceInput.tts.sampleText',
      'Hello! This is how answers sound when they are read aloud.'
    );

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
                  'Choose what apps use for voice input, transcription and read aloud. Apps follow these choices unless they pick their own in the app editor. Endpoints and keys of transcription and text-to-speech models are set under Admin → Models.'
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

        {/* Voice input (dictation) */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.voiceInput.dictation.title', 'Voice input (microphone button)')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.voiceInput.dictation.description',
                'What turns speech into text when users press the microphone button in a chat. Used by every app whose Speech Recognition Service is "Platform default".'
              )}
            </p>
          </div>

          <div>
            <label className={labelClass} htmlFor="default-service">
              {t('admin.voiceInput.dictation.service', 'Speech recognition')}
            </label>
            <select
              id="default-service"
              value={toDictationValue({
                service: config.defaultService,
                modelId: config.dictation.modelId
              })}
              onChange={e => {
                const { service, modelId } = fromDictationValue(e.target.value);
                setConfig(prev => ({
                  ...prev,
                  defaultService: service,
                  // A model choice names the model; another service keeps the
                  // last one picked, so switching back is one click.
                  dictation: service === 'model' ? { ...prev.dictation, modelId } : prev.dictation
                }));
              }}
              className={inputClass}
            >
              <option value="browser">{getSpeechServiceLabel('browser', t)}</option>
              <option value="azure">
                {getSpeechServiceLabel('azure', t)}
                {!config.azure.enabled
                  ? ` (${t('admin.voiceInput.notEnabled', 'not enabled')})`
                  : ''}
              </option>
              {((transcriptionModels || []).length > 0 || dictationModelMissing) && (
                <optgroup label={t('admin.voiceInput.services.models', 'Transcription models')}>
                  {(transcriptionModels || []).map(m => (
                    <option
                      key={m.id}
                      value={toDictationValue({ service: 'model', modelId: m.id })}
                    >
                      {modelName(m)}
                    </option>
                  ))}
                  {dictationModelMissing && (
                    <option
                      value={toDictationValue({ service: 'model', modelId: dictationModelId })}
                    >
                      {dictationModelId || t('admin.voiceInput.noModel', 'None')}
                    </option>
                  )}
                </optgroup>
              )}
            </select>
            {config.defaultService === 'azure' && !config.azure.enabled && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t(
                  'admin.voiceInput.dictation.azureNotEnabled',
                  'Azure Speech is not enabled below. Until it is, apps that follow the platform default use the browser.'
                )}
              </p>
            )}
            {config.defaultService === 'model' && (
              <p
                className={`mt-1 text-xs ${
                  dictationModelMissing
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {dictationModelMissing
                  ? t(
                      'admin.voiceInput.dictation.modelUnavailable',
                      'This model is disabled or no longer exists. Until it is enabled, apps that follow the platform default use the browser.'
                    )
                  : t(
                      'admin.voiceInput.dictation.modelHint',
                      'The microphone streams through the iHub server to this model; its endpoint and key stay on the server. Streaming models show the text while the user speaks, others insert it when they stop. Users need access to the model through their groups.'
                    )}
              </p>
            )}
            {config.defaultService === 'browser' && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.voiceInput.dictation.browserHint',
                  'Runs in the browser with the Web Speech API. Which browsers support it, and where they send the audio, is up to the browser.'
                )}
              </p>
            )}
            {Array.isArray(transcriptionModels) && transcriptionModels.length === 0 && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.voiceInput.dictation.noModels',
                  'Enable a transcription model under Admin → Models to offer it here.'
                )}
              </p>
            )}
          </div>
        </div>

        {/* Transcription (recording and uploads) */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.voiceInput.transcription.title', 'Transcription (recording and uploads)')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.voiceInput.transcription.description',
                'The model that transcribes recordings and audio/video uploads in apps that enable transcription without choosing a model of their own.'
              )}
            </p>
          </div>

          <div>
            <label className={labelClass} htmlFor="default-transcription-model">
              {t('admin.voiceInput.transcription.model', 'Model')}
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
              <option value="">{t('admin.voiceInput.noModel', 'None')}</option>
              {defaultModelMissing && <option value={defaultModelId}>{defaultModelId}</option>}
              {(transcriptionModels || []).map(m => (
                <option key={m.id} value={m.id}>
                  {modelName(m)}
                </option>
              ))}
            </select>
            {defaultModelMissing && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t(
                  'admin.voiceInput.transcription.modelUnavailable',
                  'This model is disabled or no longer exists, so recording fails in apps that rely on the default.'
                )}
              </p>
            )}
          </div>
        </div>

        {/* Read aloud (text-to-speech) */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('admin.voiceInput.tts.title', 'Read aloud (text-to-speech)')}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.voiceInput.tts.description',
                'Adds a play button to every chat message. The message is spoken by the text-to-speech model below and the audio streams while it is generated. Users only see the button when their groups may use the model; an app opts out with features.textToSpeech: false.'
              )}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={!!config.tts.enabled}
              onChange={e =>
                setConfig(prev => ({ ...prev, tts: { ...prev.tts, enabled: e.target.checked } }))
              }
              className="rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            {t('admin.voiceInput.tts.enabled', 'Show a read-aloud button on chat messages')}
          </label>

          <div>
            <label className={labelClass} htmlFor="tts-model">
              {t('admin.voiceInput.tts.model', 'Text-to-speech model')}
            </label>
            <select
              id="tts-model"
              value={ttsModelId}
              onChange={e => {
                // The test belongs to the model it was started with; choosing
                // another one (or None, which hides the controls) ends it.
                stopReadAloud(READ_ALOUD_TEST_ID);
                setConfig(prev => ({
                  ...prev,
                  tts: { ...prev.tts, defaultModelId: e.target.value }
                }));
              }}
              className={inputClass}
            >
              <option value="">{t('admin.voiceInput.noModel', 'None')}</option>
              {ttsModelMissing && <option value={ttsModelId}>{ttsModelId}</option>}
              {(ttsModels || []).map(m => (
                <option key={m.id} value={m.id}>
                  {getLocalizedContent(m.name, i18n.language) || m.id}
                  {m.enabled === false
                    ? ` (${t('admin.voiceInput.tts.modelDisabled', 'disabled')})`
                    : ''}
                </option>
              ))}
            </select>
            <p
              className={`mt-1 text-xs ${
                ttsModelMissing || ttsModelDisabled || (config.tts.enabled && !ttsModelId)
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {ttsModelMissing
                ? t(
                    'admin.voiceInput.tts.modelMissing',
                    'This model no longer exists, so no read-aloud button is shown.'
                  )
                : ttsModelDisabled
                  ? t(
                      'admin.voiceInput.tts.modelDisabledHint',
                      'This model is disabled, so no read-aloud button is shown. Enable it under Admin → Models and make sure it has an API key.'
                    )
                  : config.tts.enabled && !ttsModelId
                    ? t(
                        'admin.voiceInput.tts.noModelHint',
                        'Choose a model, or no read-aloud button is shown.'
                      )
                    : t(
                        'admin.voiceInput.tts.modelHint',
                        'Models with the type "Text-to-Speech" from Admin → Models. The voice is set on the model.'
                      )}
            </p>
          </div>

          <div className="pt-2 border-t border-gray-100 dark:border-gray-700 space-y-2">
            <label className={labelClass} htmlFor="tts-sample">
              {t('admin.voiceInput.tts.test', 'Test')}
            </label>
            <div className="flex items-center gap-3">
              <input
                id="tts-sample"
                type="text"
                value={ttsSample}
                onChange={e => setTtsSample(e.target.value)}
                placeholder={ttsSampleText}
                className="block w-full flex-1 rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
              {ttsModelId && !ttsModelMissing && (
                <span className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
                  <ReadAloudButton
                    messageId={READ_ALOUD_TEST_ID}
                    text={ttsSampleText}
                    modelId={ttsModelId}
                    playback={readAloudTest}
                  />
                </span>
              )}
            </div>
            {readAloudTest.state === 'error' && (
              <p className="text-sm text-red-600 dark:text-red-400">{readAloudTest.error}</p>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.voiceInput.tts.testHint',
                'Speaks the text with the selected model, the way a chat message is read. Works before saving, but the model must be enabled.'
              )}
            </p>
          </div>
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
                'The connection for the Azure Speech voice input service. Azure Speech runs in the browser via a short-lived token: the subscription key is stored encrypted on the server and exchanged for a token per session, so it never reaches the browser. Host/region are the defaults used when an app does not set its own host.'
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
                ? t('admin.voiceInput.testingConnection', 'Testing…')
                : t('admin.voiceInput.testConnection', 'Test connection')}
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
          speech={toPublicSpeech(savedConfig, transcriptionModels)}
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
