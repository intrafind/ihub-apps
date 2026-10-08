import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LANGUAGE } from '../../../utils/localizeContent';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import {
  validateWithSchema,
  errorsToFieldErrors,
  isFieldRequired
} from '../../../utils/schemaValidation';
import Icon from '../../../shared/components/Icon';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import AdminFormErrorSummary from './AdminFormErrorSummary';
import ApiKeyStatusBadge from './ApiKeyStatusBadge';
import useApiKeyStatus from '../hooks/useApiKeyStatus';
import TtsVoicesPanel, { TTS_LANGUAGES, languageName } from './tts/TtsVoicesPanel';
import { FormValidationProvider } from '../../../shared/contexts/formValidationContext';
import {
  isPromptCachingEnabled,
  supportsPromptCaching
} from '../../../../../shared/promptCaching.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../../../../shared/outputTokens.js';
import { isCustomLlmProvider, providerEnvKeyName } from '../../../../../shared/llmProviders.js';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { apiTypeLabel } from '../utils/modelImport';

/**
 * Editor for a JSON-typed provider config field. Keeps the raw textarea contents in
 * local state so admins can type intermediate (invalid) JSON without those characters
 * being persisted into `model.config`. The parent only ever receives the parsed
 * object/null when the input is valid; while invalid, `model.config[field.key]` keeps
 * its previous value and an inline error is shown.
 */
function JsonConfigField({ id, value, onChange, className }) {
  const { t } = useTranslation();
  const initialDraft = useMemo(() => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }, [value]);

  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState(null);

  // Keep local draft in sync when the upstream value changes from elsewhere
  // (model load, programmatic reset, switching providers).
  useEffect(() => {
    setDraft(initialDraft);
    setError(null);
  }, [initialDraft]);

  const handleChange = e => {
    const raw = e.target.value;
    setDraft(raw);
    if (!raw.trim()) {
      setError(null);
      onChange(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      setError(null);
      onChange(parsed);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      // Intentionally do NOT call onChange — keep last valid value in model.config.
    }
  };

  return (
    <>
      <textarea
        id={id}
        rows={3}
        value={draft}
        onChange={handleChange}
        aria-invalid={!!error}
        className={className}
      />
      {error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          {t('admin.models.errors.invalidJson', 'Invalid JSON')}: {error}
        </p>
      )}
    </>
  );
}

/**
 * Generate list of environment variable names that can be used for a model's API key
 * Based on the priority system in server/utils.js getApiKeyForModel()
 * @param {Object} model - The model configuration
 * @returns {Array<string>} List of environment variable names in priority order
 */
// Mistral's preset voices (GET /v1/audio/voices), offered as suggestions for
// a Mistral TTS model. Any other voice id saved in the account works too.
const MISTRAL_PRESET_VOICES = [
  'en_paul_neutral',
  'en_paul_cheerful',
  'en_paul_confident',
  'en_paul_happy',
  'en_paul_excited',
  'gb_jane_neutral',
  'gb_jane_confident',
  'gb_jane_curious',
  'gb_oliver_neutral',
  'gb_oliver_cheerful',
  'gb_oliver_confident',
  'fr_marie_neutral',
  'fr_marie_happy',
  'fr_marie_curious'
];

// The prebuilt voices of Google's Gemini TTS models. They are multilingual:
// the language is detected from the text.
const GOOGLE_PRESET_VOICES = [
  'Kore',
  'Puck',
  'Charon',
  'Zephyr',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat'
];

/** Preset voices offered as suggestions, by TTS provider. */
const TTS_PRESET_VOICES = { mistral: MISTRAL_PRESET_VOICES, google: GOOGLE_PRESET_VOICES };

const getEnvironmentVariableNames = model => {
  if (!model || !model.id || !model.provider) {
    return [];
  }

  const envVars = [];

  // Priority 1: Model-specific environment variable
  // e.g., GPT_4_AZURE1_API_KEY for model id "gpt-4-azure1"
  const modelSpecificVar = `${model.id.toUpperCase().replaceAll('-', '_')}_API_KEY`;
  envVars.push(modelSpecificVar);

  // Priority 2: Provider-specific environment variable. A model linked to a
  // custom provider reads only that provider's variable (see server/utils.js).
  if (model.providerId && model.providerId !== model.provider) {
    envVars.push(providerEnvKeyName(model.providerId));
    return envVars;
  }
  const providerMap = {
    openai: 'OPENAI_API_KEY',
    'openai-responses': 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    google: 'GOOGLE_API_KEY',
    // Gemini transcription models reuse the same Google key as the chat models.
    'google-live': 'GOOGLE_API_KEY',
    'google-transcribe': 'GOOGLE_API_KEY',
    local: 'LOCAL_API_KEY'
    // Note: iAssistant uses JWT tokens (not static API keys), handled below
  };

  // Providers with no provider-wide key: a self-hosted realtime endpoint is
  // per-model (and often needs no auth at all), and iAssistant uses JWTs.
  const noProviderWideKey = ['iassistant', 'iassistant-conversation', 'vllm-realtime'];

  const providerVar = providerMap[model.provider];
  if (providerVar) {
    // Known provider - show its env var
    envVars.push(providerVar);
  } else if (!noProviderWideKey.includes(model.provider)) {
    // Unknown provider - show generic pattern and default fallback
    envVars.push(`${model.provider.toUpperCase()}_API_KEY`);
    envVars.push('DEFAULT_API_KEY');
  }
  // For iAssistant, don't add any more variables since it uses JWT tokens

  return envVars;
};

/**
 * Form-based editor for model configuration
 * @param {Object} props
 * @param {Object} props.value - Model configuration data
 * @param {Function} props.onChange - Callback when data changes
 * @param {Object} props.errors - Validation errors object
 * @param {boolean} props.isNewModel - Whether this is a new model
 */
function ModelFormEditor({
  value: data,
  onChange,
  onValidationChange,
  errors = {},
  isNewModel = false,
  jsonSchema
}) {
  const { t, i18n } = useTranslation();
  const [validationErrors, setValidationErrors] = useState({});
  const { statuses: keyStatuses } = useApiKeyStatus('models');
  // What the server says about the saved key; a model not saved yet has none.
  const keyStatus = isNewModel ? undefined : keyStatuses[data.id];

  // Validation function
  const validateModel = modelData => {
    let errors = {};

    // Use schema validation if available
    if (jsonSchema) {
      const validation = validateWithSchema(modelData, jsonSchema);
      if (!validation.isValid) {
        errors = errorsToFieldErrors(validation.errors);
      }
    } else {
      // Fallback to basic validation if no schema
      if (!modelData.id) {
        errors.id = 'Model ID is required';
      }
      if (!modelData.name) {
        errors.name = 'Model name is required';
      }
    }

    setValidationErrors(errors);

    const isValid = Object.keys(errors).length === 0;
    if (onValidationChange) {
      onValidationChange({
        isValid,
        errors: Object.entries(errors).map(([field, message]) => ({
          field,
          message,
          severity: 'error'
        }))
      });
    }

    return isValid;
  };

  // Validate on data changes
  useEffect(() => {
    if (data) {
      validateModel(data);
    }
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [data, jsonSchema]);

  // Adapter-declared provider config schema (e.g. AWS Bedrock region).
  // Drives dynamic field rendering in the Configuration section.
  const [providerSchema, setProviderSchema] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!data?.provider) {
      setProviderSchema(null);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        // makeAdminApiCall returns an axios response object: `{ data, status, ... }`,
        // not a fetch Response. Read schema via `response.data`.
        const response = await makeAdminApiCall(
          `/admin/providers/${encodeURIComponent(data.provider)}/schema`
        );
        if (cancelled) return;
        setProviderSchema(response?.data || null);
      } catch {
        if (!cancelled) setProviderSchema(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.provider]);

  // Custom LLM providers (e.g. a T-Systems LLM Hub entry) are offered next to
  // the API types: picking one links the model to it and takes its API type.
  const [customProviders, setCustomProviders] = useState([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await makeAdminApiCall('/admin/providers');
        if (cancelled) return;
        const list = Array.isArray(response?.data) ? response.data : [];
        setCustomProviders(list.filter(isCustomLlmProvider));
      } catch {
        if (!cancelled) setCustomProviders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const linkedProvider = data.providerId
    ? customProviders.find(p => p.id === data.providerId)
    : null;

  const handleProviderSelect = e => {
    const value = e.target.value;
    const custom = customProviders.find(p => p.id === value);
    if (custom) {
      onChange({ ...data, providerId: custom.id, provider: custom.apiType });
      return;
    }
    const { providerId: _unlinked, ...rest } = data;
    onChange({ ...rest, provider: value });
  };

  const handleChange = (field, value) => {
    onChange({ ...data, [field]: value });
  };

  const handleConfigChange = (key, value) => {
    onChange({
      ...data,
      config: { ...data.config, [key]: value }
    });
  };

  // `thinking` is an optional nested object and the schema is strict, so an
  // empty `{}` would fail validation: turning reasoning off drops the key
  // entirely rather than leaving `{ enabled: false }` behind.
  const handleThinkingChange = (key, value) => {
    const next = { ...data.thinking, [key]: value };
    if (key === 'enabled' && !value) {
      const { thinking: _dropped, ...rest } = data;
      onChange(rest);
      return;
    }
    if (value === '' || value === null || value === undefined) delete next[key];
    onChange({ ...data, thinking: next });
  };

  const handleInputChange = e => {
    const { name, value, type, checked } = e.target;
    handleChange(name, type === 'checkbox' ? checked : value);
  };

  const isTranscription = data.modelType === 'transcription';
  const isTts = data.modelType === 'tts';
  // Chat-only settings (context window, reasoning, …) mean nothing to a model
  // that turns audio into text or text into audio.
  const isChat = !isTranscription && !isTts;

  const handleTtsChange = (key, value) => {
    const next = { ...data.tts };
    if (value === '' || value === null || value === undefined) delete next[key];
    else next[key] = value;
    onChange({ ...data, tts: next });
  };

  // Voices per language (`tts.voices`), in the order the admin added them.
  // Language codes and voice ids are cut down to the characters they can
  // contain before they reach the model data.
  const ttsVoiceEntries = Object.entries(data.tts?.voices || {});
  const setTtsVoices = entries => {
    const next = { ...data.tts };
    if (entries.length) next.voices = Object.fromEntries(entries);
    else delete next.voices;
    onChange({ ...data, tts: next });
  };
  const addTtsVoiceLanguage = () => {
    const used = new Set(ttsVoiceEntries.map(([code]) => code));
    const code = TTS_LANGUAGES.find(language => !used.has(language));
    if (code) setTtsVoices([...ttsVoiceEntries, [code, '']]);
  };
  // From the voices panel: a voice for the whole model, or for one language.
  const handleUseVoice = (voiceId, language) => {
    const id = String(voiceId).replaceAll(/[^\w-]/g, '');
    if (!language) {
      handleTtsChange('voice', id);
      return;
    }
    const code = String(language).replaceAll(/[^a-z]/g, '');
    const exists = ttsVoiceEntries.some(([entry]) => entry === code);
    setTtsVoices(
      exists
        ? ttsVoiceEntries.map(([entry, voice]) => [entry, entry === code ? id : voice])
        : [...ttsVoiceEntries, [code, id]]
    );
  };

  const providerOptions = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'openai-responses', label: 'OpenAI (Responses API)' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'local', label: 'Local' },
    { value: 'iassistant', label: 'iAssistant' },
    { value: 'iassistant-conversation', label: 'iAssistant Conversation' },
    { value: 'bedrock', label: 'AWS Bedrock' },
    { value: 'vllm-realtime', label: 'vLLM Realtime (Transcription)' },
    { value: 'google-live', label: 'Google Gemini Live (Transcription)' },
    { value: 'google-transcribe', label: 'Google Gemini Batch (Transcription)' }
  ];

  // Memoize environment variables tooltip text for API Key field
  const apiKeyTooltip = useMemo(() => {
    if (!data.id || !data.provider) {
      return null;
    }
    const envVarsList = getEnvironmentVariableNames({
      id: data.id,
      provider: data.provider,
      providerId: data.providerId
    }).join('\n');
    return t(
      'admin.models.hints.apiKeyEnvVars',
      `Environment variables (in priority order):\n${envVarsList}`,
      { envVars: envVarsList }
    );
  }, [data.id, data.provider, data.providerId, t]);

  const mergedErrors = { ...errors, ...validationErrors };
  const errorLabels = {
    id: t('admin.models.fields.id', 'Model ID'),
    name: t('admin.models.fields.name', 'Name'),
    description: t('admin.models.fields.description', 'Description'),
    provider: t('admin.models.fields.provider', 'Provider'),
    modelId: t('admin.models.fields.modelId', 'Model'),
    url: t('admin.models.fields.url', 'URL'),
    contextWindow: t('admin.models.fields.contextWindow', 'Context Window'),
    maxOutputTokens: t('admin.models.fields.maxOutputTokens', 'Max Output Tokens')
  };

  return (
    <FormValidationProvider errors={mergedErrors}>
      <div className="space-y-6">
        <AdminFormErrorSummary
          errors={mergedErrors}
          labels={errorLabels}
          title={t('admin.models.edit.fixErrors', 'Please fix the following errors')}
        />
        {/* Basic Information */}
        <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
                {t('admin.models.edit.basicInfo')}
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t('admin.models.edit.basicInfoDesc', 'Basic information about the model')}
              </p>
            </div>
            <div className="mt-5 md:mt-0 md:col-span-2">
              <div className="grid grid-cols-6 gap-6">
                <div className="col-span-6 sm:col-span-3">
                  <label
                    htmlFor="id"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.fields.id')}
                    {isFieldRequired('id', jsonSchema) && <span className="text-red-500"> *</span>}
                  </label>
                  <input
                    type="text"
                    name="id"
                    id="id"
                    value={data.id || ''}
                    onChange={handleInputChange}
                    disabled={!isNewModel}
                    className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 rounded-md disabled:bg-gray-100 dark:disabled:bg-gray-700 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 ${
                      validationErrors.id || errors.id
                        ? 'border-red-300 text-red-900 placeholder-red-300'
                        : ''
                    }`}
                    required={isFieldRequired('id', jsonSchema)}
                  />
                  {(validationErrors.id || errors.id) && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                      {validationErrors.id || errors.id}
                    </p>
                  )}
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {t('admin.models.hints.modelId')}
                  </p>
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <DynamicLanguageEditor
                    label={`${t('admin.models.fields.name')} *`}
                    value={data.name || { [DEFAULT_LANGUAGE]: '' }}
                    onChange={value => handleChange('name', value)}
                    required={true}
                    error={errors.name}
                  />
                </div>

                <div className="col-span-6">
                  <DynamicLanguageEditor
                    label={`${t('admin.models.fields.description')} *`}
                    value={data.description || { [DEFAULT_LANGUAGE]: '' }}
                    onChange={value => handleChange('description', value)}
                    required={true}
                    type="textarea"
                    error={errors.description}
                  />
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label
                    htmlFor="modelType"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.fields.modelType', 'Model Type')}
                  </label>
                  <select
                    id="modelType"
                    name="modelType"
                    value={data.modelType || 'chat'}
                    onChange={handleInputChange}
                    className="mt-1 block w-full py-2 px-3 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  >
                    <option value="chat">{t('admin.models.modelType.chat', 'Chat')}</option>
                    <option value="transcription">
                      {t('admin.models.modelType.transcription', 'Transcription')}
                    </option>
                    <option value="tts">{t('admin.models.modelType.tts', 'Text-to-Speech')}</option>
                  </select>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.models.hints.modelType',
                      'Chat models answer prompts. Transcription models convert audio to text via a realtime endpoint (e.g. Voxtral). Text-to-speech models read chat messages aloud (e.g. Voxtral TTS).'
                    )}
                  </p>
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label
                    htmlFor="provider"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.fields.provider')} <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="provider"
                    name="provider"
                    value={data.providerId || data.provider || ''}
                    onChange={handleProviderSelect}
                    className={`mt-1 block w-full py-2 px-3 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm ${
                      errors.provider ? 'border-red-300 text-red-900' : ''
                    }`}
                    required
                  >
                    <option value="">{t('admin.models.placeholders.selectProvider')}</option>
                    {providerOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                    {customProviders.length > 0 && (
                      <optgroup
                        label={t('admin.models.fields.customProviders', 'Custom providers')}
                      >
                        {customProviders.map(p => (
                          <option key={p.id} value={p.id}>
                            {getLocalizedContent(p.name) || p.id} ({apiTypeLabel(t, p.apiType)})
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {data.providerId && !linkedProvider && (
                      <option value={data.providerId}>{data.providerId}</option>
                    )}
                  </select>
                  {errors.provider && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errors.provider}</p>
                  )}
                  {data.providerId && (
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.models.hints.linkedProvider',
                        'Uses the API key of the provider "{{provider}}" and its API type ({{apiType}}).',
                        {
                          provider: getLocalizedContent(linkedProvider?.name) || data.providerId,
                          apiType: apiTypeLabel(t, data.provider)
                        }
                      )}
                    </p>
                  )}
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label
                    htmlFor="modelId"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.fields.modelId')}
                  </label>
                  <input
                    type="text"
                    name="modelId"
                    id="modelId"
                    value={data.modelId || ''}
                    onChange={handleInputChange}
                    placeholder={t('admin.models.placeholders.apiModelId')}
                    className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md ${
                      errors.modelId ? 'border-red-300 text-red-900 placeholder-red-300' : ''
                    }`}
                  />
                  {errors.modelId && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errors.modelId}</p>
                  )}
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {t('admin.models.hints.apiModelId')}
                  </p>
                </div>

                {/*
                Bedrock builds its endpoint URL from `region` + `modelId` at request time, so
                a URL field would only confuse admins. Hide the field entirely for Bedrock.
              */}
                {data.provider !== 'bedrock' && (
                  <div className="col-span-6">
                    <label
                      htmlFor="url"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                      {t('admin.models.fields.url')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type={isTranscription ? 'text' : 'url'}
                      name="url"
                      id="url"
                      value={data.url || ''}
                      onChange={handleInputChange}
                      placeholder={
                        isTranscription
                          ? data.provider === 'mistral'
                            ? 'wss://api.mistral.ai/v1/audio/transcriptions/realtime'
                            : data.provider === 'openai' || data.provider === 'local'
                              ? 'https://llm-server.llmhub.t-systems.net/v2/audio/transcriptions'
                              : t(
                                  'admin.models.placeholders.realtimeUrl',
                                  'ws://host:8080/v1/realtime'
                                )
                          : isTts
                            ? data.provider === 'google'
                              ? 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:streamGenerateContent'
                              : 'https://api.mistral.ai/v1/audio/speech'
                            : t('admin.models.placeholders.apiUrl')
                      }
                      className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md ${
                        errors.url ? 'border-red-300 text-red-900 placeholder-red-300' : ''
                      }`}
                      required
                    />
                    {isTranscription && (
                      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.models.hints.realtimeUrl',
                          'Endpoint of the transcription service: a vLLM /v1/realtime WebSocket URL, an OpenAI-compatible /audio/transcriptions URL (Whisper with the OpenAI or Local provider), or the provider’s API. It stays server-side and never reaches the browser.'
                        )}
                      </p>
                    )}
                    {isTts && (
                      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.models.hints.ttsUrl',
                          'Speech endpoint of the provider. It stays server-side and never reaches the browser.'
                        )}
                      </p>
                    )}
                    {errors.url && (
                      <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errors.url}</p>
                    )}
                  </div>
                )}

                {isTts && (
                  <div className="col-span-6 sm:col-span-3">
                    <label
                      htmlFor="ttsVoice"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                      {t('admin.models.fields.ttsVoice', 'Voice')}
                    </label>
                    <input
                      type="text"
                      id="ttsVoice"
                      list="ttsVoiceOptions"
                      value={data.tts?.voice || ''}
                      // Voice ids are slugs or UUIDs: keep only what one can contain.
                      onChange={e =>
                        handleTtsChange('voice', e.target.value.replaceAll(/[^\w-]/g, ''))
                      }
                      placeholder={data.provider === 'google' ? 'Kore' : 'en_paul_neutral'}
                      className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md"
                    />
                    {TTS_PRESET_VOICES[data.provider] && (
                      <datalist id="ttsVoiceOptions">
                        {TTS_PRESET_VOICES[data.provider].map(voice => (
                          <option key={voice} value={voice} />
                        ))}
                      </datalist>
                    )}
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      {data.provider === 'google'
                        ? t(
                            'admin.models.hints.ttsVoiceGoogle',
                            'One of the prebuilt Gemini voices, such as Kore, Puck or Charon. Each speaks every language, which is detected from the text. Empty uses Kore.'
                          )
                        : t(
                            'admin.models.hints.ttsVoice',
                            'Voice id of the provider: a Mistral preset such as en_paul_neutral, gb_jane_neutral or fr_marie_neutral, or the id of a voice saved in your Mistral account. Empty uses en_paul_neutral.'
                          )}
                    </p>
                  </div>
                )}

                {isTts && (
                  <div className="col-span-6 space-y-2">
                    <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.models.fields.ttsVoices', 'Voices per language')}
                    </span>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.models.hints.ttsVoices',
                        'A message written in one of these languages is read with that voice; every other language uses the voice above. The language is told from the message itself.'
                      )}
                    </p>
                    {ttsVoiceEntries.map(([code, voice]) => (
                      <div key={code} className="flex items-center gap-2">
                        <select
                          aria-label={t('admin.models.fields.ttsVoiceLanguage', 'Language')}
                          value={code}
                          onChange={e => {
                            const next = e.target.value.replaceAll(/[^a-z]/g, '');
                            setTtsVoices(
                              ttsVoiceEntries.map(([entry, id]) => [
                                entry === code ? next : entry,
                                id
                              ])
                            );
                          }}
                          className="block w-40 py-2 px-3 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs sm:text-sm"
                        >
                          {TTS_LANGUAGES.filter(
                            language =>
                              language === code ||
                              !ttsVoiceEntries.some(([entry]) => entry === language)
                          ).map(language => (
                            <option key={language} value={language}>
                              {languageName(language, i18n.language)}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          list="ttsVoiceOptions"
                          aria-label={t('admin.models.fields.ttsVoice', 'Voice')}
                          value={voice}
                          onChange={e => {
                            const next = e.target.value.replaceAll(/[^\w-]/g, '');
                            setTtsVoices(
                              ttsVoiceEntries.map(([entry, id]) => [
                                entry,
                                entry === code ? next : id
                              ])
                            );
                          }}
                          placeholder={t('admin.models.placeholders.ttsVoiceId', 'Voice id')}
                          className="block flex-1 shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setTtsVoices(ttsVoiceEntries.filter(([entry]) => entry !== code))
                          }
                          className="p-2 text-gray-500 hover:text-red-600"
                          title={t('admin.models.ttsVoices.removeLanguage', 'Remove')}
                          aria-label={t('admin.models.ttsVoices.removeLanguage', 'Remove')}
                        >
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                    ))}
                    {ttsVoiceEntries.length < TTS_LANGUAGES.length && (
                      <button
                        type="button"
                        onClick={addTtsVoiceLanguage}
                        className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
                      >
                        {t(
                          'admin.models.actions.addTtsVoiceLanguage',
                          '+ Add a voice for a language'
                        )}
                      </button>
                    )}
                    {data.provider === 'mistral' &&
                      (isNewModel ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t(
                            'admin.models.hints.ttsVoicesAfterSave',
                            'Save the model once to browse the provider’s voices and create custom voices here.'
                          )}
                        </p>
                      ) : (
                        <TtsVoicesPanel
                          modelId={data.id}
                          onUseVoice={handleUseVoice}
                          t={t}
                          uiLanguage={i18n.language}
                        />
                      ))}
                  </div>
                )}

                <div className="col-span-6">
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="apiKey"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                      {t('admin.models.fields.apiKey', 'API Key')}
                    </label>
                    {apiKeyTooltip && (
                      <Icon
                        name="information-circle"
                        size="sm"
                        className="text-gray-400 dark:text-gray-500 cursor-help"
                        title={apiKeyTooltip}
                      />
                    )}
                  </div>
                  <div className="mt-1 relative rounded-md shadow-xs">
                    <input
                      type="password"
                      name="apiKey"
                      id="apiKey"
                      value={data.apiKey || ''}
                      onChange={handleInputChange}
                      placeholder={
                        data.apiKeySet
                          ? t(
                              'admin.models.placeholders.apiKeySet',
                              'API key is set (leave blank to keep current)'
                            )
                          : t(
                              'admin.models.placeholders.apiKey',
                              'Enter API key (optional - will use environment variable if not set)'
                            )
                      }
                      className="focus:ring-indigo-500 focus:border-indigo-500 block w-full pr-10 sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md"
                    />
                  </div>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.models.hints.apiKey',
                      'API key for this model. If not provided, the system will use the environment variable for the provider. Keys are stored encrypted.'
                    )}
                  </p>
                  {data.apiKeySet && !keyStatus && (
                    <p className="mt-2 text-sm text-blue-600 dark:text-blue-400">
                      {t('admin.models.hints.apiKeySet', '✓ API key is configured for this model')}
                    </p>
                  )}
                  {keyStatus && (
                    <div className="mt-3">
                      <ApiKeyStatusBadge status={keyStatus} detailed />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Configuration */}
        <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
                {t('admin.models.edit.configuration')}
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t(
                  'admin.models.edit.configurationDesc',
                  'Advanced configuration options for the model'
                )}
              </p>
            </div>
            <div className="mt-5 md:mt-0 md:col-span-2">
              <div className="grid grid-cols-6 gap-6">
                {isChat && (
                  <>
                    <div className="col-span-6 sm:col-span-2">
                      <label
                        htmlFor="contextWindow"
                        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                      >
                        {t('admin.models.fields.contextWindow', 'Context Window')}
                        {isFieldRequired('contextWindow', jsonSchema) && (
                          <span className="text-red-500"> *</span>
                        )}
                      </label>
                      <input
                        type="number"
                        name="contextWindow"
                        id="contextWindow"
                        value={data.contextWindow || ''}
                        onChange={handleInputChange}
                        min="1"
                        className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md ${
                          errors.contextWindow ? 'border-red-300 text-red-900' : ''
                        }`}
                        required={isFieldRequired('contextWindow', jsonSchema)}
                      />
                      {errors.contextWindow && (
                        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                          {errors.contextWindow}
                        </p>
                      )}
                    </div>
                    <div className="col-span-6 sm:col-span-2">
                      <label
                        htmlFor="maxOutputTokens"
                        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                      >
                        {t('admin.models.fields.maxOutputTokens', 'Max Output Tokens')}
                        {isFieldRequired('maxOutputTokens', jsonSchema) && (
                          <span className="text-red-500"> *</span>
                        )}
                      </label>
                      <input
                        type="number"
                        name="maxOutputTokens"
                        id="maxOutputTokens"
                        value={data.maxOutputTokens || ''}
                        onChange={handleInputChange}
                        min="1"
                        className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md ${
                          errors.maxOutputTokens ? 'border-red-300 text-red-900' : ''
                        }`}
                        placeholder={t('admin.models.placeholders.maxOutputTokens', {
                          defaultValue: 'Default: {{value}}',
                          value: DEFAULT_MAX_OUTPUT_TOKENS
                        })}
                        required={isFieldRequired('maxOutputTokens', jsonSchema)}
                      />
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {t('admin.models.hints.maxOutputTokens', {
                          defaultValue:
                            'Empty means the default ({{value}}), not unlimited. Reasoning models spend their thinking tokens from this limit, so keep it well above the longest answer you expect.',
                          value: DEFAULT_MAX_OUTPUT_TOKENS
                        })}
                      </p>
                      {errors.maxOutputTokens && (
                        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                          {errors.maxOutputTokens}
                        </p>
                      )}
                    </div>
                  </>
                )}

                <div className="col-span-6 sm:col-span-2">
                  <label
                    htmlFor="concurrency"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.fields.concurrency')}
                  </label>
                  <input
                    type="number"
                    name="concurrency"
                    id="concurrency"
                    value={data.concurrency || ''}
                    onChange={handleInputChange}
                    min="1"
                    className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md ${
                      errors.concurrency ? 'border-red-300 text-red-900' : ''
                    }`}
                  />
                  {errors.concurrency && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                      {errors.concurrency}
                    </p>
                  )}
                </div>

                <div className="col-span-6 sm:col-span-2">
                  <label
                    htmlFor="requestDelayMs"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.fields.requestDelay')}
                  </label>
                  <input
                    type="number"
                    name="requestDelayMs"
                    id="requestDelayMs"
                    value={data.requestDelayMs || ''}
                    onChange={handleInputChange}
                    min="0"
                    className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md ${
                      errors.requestDelayMs ? 'border-red-300 text-red-900' : ''
                    }`}
                  />
                  {errors.requestDelayMs && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                      {errors.requestDelayMs}
                    </p>
                  )}
                </div>

                <div className="col-span-6 sm:col-span-2">
                  <label
                    htmlFor="connectTimeoutMs"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.fields.connectTimeoutMs', 'Connect Timeout (ms)')}
                  </label>
                  <input
                    type="number"
                    name="connectTimeoutMs"
                    id="connectTimeoutMs"
                    value={data.connectTimeoutMs ?? ''}
                    onChange={handleInputChange}
                    min="0"
                    max="300000"
                    className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md ${
                      errors.connectTimeoutMs ? 'border-red-300 text-red-900' : ''
                    }`}
                  />
                  {errors.connectTimeoutMs && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                      {errors.connectTimeoutMs}
                    </p>
                  )}
                </div>

                <div className="col-span-6 sm:col-span-2">
                  <label
                    htmlFor="streamIdleTimeoutMs"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.models.fields.streamIdleTimeoutMs', 'Stream Idle Timeout (ms)')}
                  </label>
                  <input
                    type="number"
                    name="streamIdleTimeoutMs"
                    id="streamIdleTimeoutMs"
                    value={data.streamIdleTimeoutMs ?? ''}
                    onChange={handleInputChange}
                    min="0"
                    max="300000"
                    className={`mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md ${
                      errors.streamIdleTimeoutMs ? 'border-red-300 text-red-900' : ''
                    }`}
                  />
                  {errors.streamIdleTimeoutMs && (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                      {errors.streamIdleTimeoutMs}
                    </p>
                  )}
                </div>

                <div className="col-span-6">
                  <fieldset>
                    <legend className="text-base font-medium text-gray-900 dark:text-gray-100">
                      Options
                    </legend>
                    <div className="mt-4 space-y-4">
                      <div className="flex items-start">
                        <div className="flex items-center h-5">
                          <input
                            id="supportsTools"
                            name="supportsTools"
                            type="checkbox"
                            checked={data.supportsTools || false}
                            onChange={handleInputChange}
                            className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                          />
                        </div>
                        <div className="ml-3 text-sm">
                          <label
                            htmlFor="supportsTools"
                            className="font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.supportsTools')}
                          </label>
                        </div>
                      </div>
                      <div className="flex items-start">
                        <div className="flex items-center h-5">
                          <input
                            id="supportsVision"
                            name="supportsVision"
                            type="checkbox"
                            checked={data.supportsVision || false}
                            onChange={handleInputChange}
                            className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                          />
                        </div>
                        <div className="ml-3 text-sm">
                          <label
                            htmlFor="supportsVision"
                            className="font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.supportsVision', 'Supports Vision')}
                          </label>
                          <p className="text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.models.hints.supportsVision',
                              'Enable if this model can process image inputs'
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-start">
                        <div className="flex items-center h-5">
                          <input
                            id="supportsAudio"
                            name="supportsAudio"
                            type="checkbox"
                            checked={data.supportsAudio || false}
                            onChange={handleInputChange}
                            className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                          />
                        </div>
                        <div className="ml-3 text-sm">
                          <label
                            htmlFor="supportsAudio"
                            className="font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.supportsAudio', 'Supports Audio')}
                          </label>
                          <p className="text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.models.hints.supportsAudio',
                              'Enable if this model can process audio inputs'
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-start">
                        <div className="flex items-center h-5">
                          <input
                            id="enabled"
                            name="enabled"
                            type="checkbox"
                            checked={data.enabled !== false}
                            onChange={handleInputChange}
                            className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                          />
                        </div>
                        <div className="ml-3 text-sm">
                          <label
                            htmlFor="enabled"
                            className="font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.enabled')}
                          </label>
                        </div>
                      </div>
                      {/* Only a chat model can be the default chat model. */}
                      {isChat && (
                        <div className="flex items-start">
                          <div className="flex items-center h-5">
                            <input
                              id="default"
                              name="default"
                              type="checkbox"
                              checked={data.default || false}
                              onChange={handleInputChange}
                              className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                            />
                          </div>
                          <div className="ml-3 text-sm">
                            <label
                              htmlFor="default"
                              className="font-medium text-gray-700 dark:text-gray-300"
                            >
                              {t('admin.models.fields.defaultModel')}
                            </label>
                          </div>
                        </div>
                      )}
                      <div className="flex items-start">
                        <div className="flex items-center h-5">
                          <input
                            id="supportsImageGeneration"
                            name="supportsImageGeneration"
                            type="checkbox"
                            checked={data.supportsImageGeneration || false}
                            onChange={handleInputChange}
                            className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                          />
                        </div>
                        <div className="ml-3 text-sm">
                          <label
                            htmlFor="supportsImageGeneration"
                            className="font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t(
                              'admin.models.fields.supportsImageGeneration',
                              'Supports Image Generation'
                            )}
                          </label>
                          <p className="text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.models.hints.supportsImageGeneration',
                              'Enable if this model can generate images (e.g., Gemini Image models)'
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-start">
                        <div className="flex items-center h-5">
                          <input
                            id="autoDiscovery"
                            name="autoDiscovery"
                            type="checkbox"
                            checked={data.autoDiscovery || false}
                            onChange={handleInputChange}
                            disabled={!(data.provider === 'openai' || data.provider === 'local')}
                            className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                        </div>
                        <div className="ml-3 text-sm">
                          <label
                            htmlFor="autoDiscovery"
                            className={`font-medium ${
                              data.provider === 'openai' || data.provider === 'local'
                                ? 'text-gray-700 dark:text-gray-300'
                                : 'text-gray-400 dark:text-gray-600'
                            }`}
                          >
                            {t('admin.models.fields.autoDiscovery', 'Auto Discovery')}
                          </label>
                          <p className="text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.models.hints.autoDiscovery',
                              'Automatically detect the active model from the /v1/models endpoint. Useful for local LLM providers (vLLM, LM Studio, Jan.ai) where the model can change. Only available for OpenAI-compatible providers.'
                            )}
                          </p>
                        </div>
                      </div>
                    </div>
                  </fieldset>
                </div>

                {isChat && (
                  <div className="col-span-6">
                    <fieldset>
                      <legend className="text-base font-medium text-gray-900 dark:text-gray-100">
                        {t('admin.models.sections.thinking', 'Reasoning')}
                      </legend>
                      <div className="mt-4 flex items-start">
                        <div className="flex items-center h-5">
                          <input
                            id="thinking.enabled"
                            type="checkbox"
                            checked={data.thinking?.enabled || false}
                            onChange={e => handleThinkingChange('enabled', e.target.checked)}
                            className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                          />
                        </div>
                        <div className="ml-3 text-sm">
                          <label
                            htmlFor="thinking.enabled"
                            className="font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.thinkingEnabled', 'Enable reasoning')}
                          </label>
                          <p className="text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.models.hints.thinkingEnabled',
                              'Ask the model to think before answering. The reasoning is returned separately from the answer; leave off and a reasoning model writes its thinking into the answer text instead.'
                            )}
                          </p>
                        </div>
                      </div>
                      {data.thinking?.enabled && (
                        <div className="mt-4 ml-7 space-y-4">
                          <div className="max-w-xs">
                            <label
                              htmlFor="thinking.level"
                              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                            >
                              {t('admin.models.fields.thinkingLevel', 'Reasoning effort')}
                            </label>
                            <select
                              id="thinking.level"
                              value={data.thinking?.level || ''}
                              onChange={e => handleThinkingChange('level', e.target.value)}
                              className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md"
                            >
                              <option value="">
                                {t('admin.models.fields.thinkingLevelDefault', 'Provider default')}
                              </option>
                              <option value="minimal">
                                {t('admin.models.fields.thinkingLevelMinimal', 'Minimal')}
                              </option>
                              <option value="low">
                                {t('admin.models.fields.thinkingLevelLow', 'Low')}
                              </option>
                              <option value="medium">
                                {t('admin.models.fields.thinkingLevelMedium', 'Medium')}
                              </option>
                              <option value="high">
                                {t('admin.models.fields.thinkingLevelHigh', 'High')}
                              </option>
                            </select>
                            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                              {t(
                                'admin.models.hints.thinkingLevel',
                                'Sent as reasoning_effort (OpenAI, vLLM) or thinkingLevel (Gemini). Servers that do not support it ignore the value — leave on provider default unless the model documents these levels.'
                              )}
                            </p>
                          </div>
                          <div className="flex items-start">
                            <div className="flex items-center h-5">
                              <input
                                id="thinking.thoughts"
                                type="checkbox"
                                checked={data.thinking?.thoughts !== false}
                                onChange={e => handleThinkingChange('thoughts', e.target.checked)}
                                className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                              />
                            </div>
                            <div className="ml-3 text-sm">
                              <label
                                htmlFor="thinking.thoughts"
                                className="font-medium text-gray-700 dark:text-gray-300"
                              >
                                {t('admin.models.fields.thinkingThoughts', 'Show reasoning')}
                              </label>
                              <p className="text-gray-500 dark:text-gray-400">
                                {t(
                                  'admin.models.hints.thinkingThoughts',
                                  'Surface the reasoning to users behind the "Show thinking" toggle. Turn off to keep it hidden.'
                                )}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </fieldset>
                  </div>
                )}

                {supportsPromptCaching(data.provider) && (
                  <div className="col-span-6">
                    <fieldset>
                      <legend className="text-base font-medium text-gray-900 dark:text-gray-100">
                        {t('admin.models.sections.promptCaching', 'Prompt Caching')}
                      </legend>
                      <div className="mt-4 flex items-start">
                        <div className="flex items-center h-5">
                          <input
                            id="promptCaching.enabled"
                            type="checkbox"
                            checked={isPromptCachingEnabled(data)}
                            onChange={e =>
                              handleChange('promptCaching', { enabled: e.target.checked })
                            }
                            className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                          />
                        </div>
                        <div className="ml-3 text-sm">
                          <label
                            htmlFor="promptCaching.enabled"
                            className="font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.promptCachingEnabled', 'Use prompt caching')}
                          </label>
                          <p className="text-gray-500 dark:text-gray-400">
                            {data.provider === 'openai' || data.provider === 'openai-responses'
                              ? t(
                                  'admin.models.hints.promptCachingOpenAI',
                                  'Sends a cache key so requests that start with the same prompt reuse OpenAI’s cache. On by default for api.openai.com; turn it off for OpenAI-compatible servers that reject unknown parameters.'
                                )
                              : t(
                                  'admin.models.hints.promptCachingExplicit',
                                  'Marks the tools, system prompt and conversation for caching. Cached input costs about a tenth of normal input, but writing it costs a quarter more, so this pays off when the same app is used again within five minutes. Only for models that support prompt caching.'
                                )}
                          </p>
                        </div>
                      </div>
                    </fieldset>
                  </div>
                )}

                {/* Image Generation Configuration */}
                {['anthropic', 'google', 'openai-responses'].includes(data.provider) && (
                  <div className="col-span-6">
                    <fieldset>
                      <legend className="text-base font-medium text-gray-900 dark:text-gray-100">
                        {t('admin.models.sections.nativeWebSearch', 'Native Web Search')}
                      </legend>
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.models.hints.nativeWebSearch',
                          "Apps with web search use the provider's built-in search on this model. Turn it off for models or gateways that do not support it; they fall back to Brave Search."
                        )}
                      </p>
                      <div className="mt-4 space-y-4">
                        <div className="flex items-start">
                          <div className="flex items-center h-5">
                            <input
                              id="nativeWebSearch.enabled"
                              type="checkbox"
                              checked={data.nativeWebSearch?.enabled !== false}
                              onChange={e =>
                                handleChange('nativeWebSearch', {
                                  ...data.nativeWebSearch,
                                  enabled: e.target.checked
                                })
                              }
                              className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm"
                            />
                          </div>
                          <div className="ml-3 text-sm">
                            <label
                              htmlFor="nativeWebSearch.enabled"
                              className="font-medium text-gray-700 dark:text-gray-300"
                            >
                              {t(
                                'admin.models.fields.nativeWebSearchEnabled',
                                'Use native web search'
                              )}
                            </label>
                          </div>
                        </div>

                        {data.provider === 'anthropic' &&
                          data.nativeWebSearch?.enabled !== false && (
                            <>
                              <div>
                                <label
                                  htmlFor="nativeWebSearch.toolVersion"
                                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                                >
                                  {t(
                                    'admin.models.fields.nativeWebSearchToolVersion',
                                    'Web search tool version'
                                  )}
                                </label>
                                <select
                                  id="nativeWebSearch.toolVersion"
                                  value={data.nativeWebSearch?.toolVersion || 'web_search_20250305'}
                                  onChange={e =>
                                    handleChange('nativeWebSearch', {
                                      ...data.nativeWebSearch,
                                      toolVersion: e.target.value
                                    })
                                  }
                                  className="mt-1 block w-full py-2 px-3 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                                >
                                  <option value="web_search_20250305">
                                    web_search_20250305 —{' '}
                                    {t(
                                      'admin.models.fields.nativeWebSearchVersionBasic',
                                      'basic (all Claude models, Vertex AI, Foundry)'
                                    )}
                                  </option>
                                  <option value="web_search_20260209">
                                    web_search_20260209 —{' '}
                                    {t(
                                      'admin.models.fields.nativeWebSearchVersionFiltering',
                                      'dynamic filtering (Claude 4.6 and later)'
                                    )}
                                  </option>
                                  <option value="web_search_20260318">
                                    web_search_20260318 —{' '}
                                    {t(
                                      'admin.models.fields.nativeWebSearchVersionInclusion',
                                      'dynamic filtering + response inclusion (Claude 4.6 and later)'
                                    )}
                                  </option>
                                </select>
                                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                                  {t(
                                    'admin.models.hints.nativeWebSearchToolVersion',
                                    'Newer versions let Claude filter search results in code before they reach the context window, which saves tokens on search-heavy prompts. Google Cloud and Azure-hosted Foundry only offer the basic version.'
                                  )}
                                </p>
                              </div>
                              <div className="flex items-start">
                                <div className="flex items-center h-5">
                                  <input
                                    id="nativeWebSearch.dynamicFiltering"
                                    type="checkbox"
                                    disabled={
                                      (data.nativeWebSearch?.toolVersion ||
                                        'web_search_20250305') === 'web_search_20250305'
                                    }
                                    checked={data.nativeWebSearch?.dynamicFiltering === true}
                                    onChange={e =>
                                      handleChange('nativeWebSearch', {
                                        ...data.nativeWebSearch,
                                        dynamicFiltering: e.target.checked
                                      })
                                    }
                                    className="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded-sm disabled:opacity-50"
                                  />
                                </div>
                                <div className="ml-3 text-sm">
                                  <label
                                    htmlFor="nativeWebSearch.dynamicFiltering"
                                    className="font-medium text-gray-700 dark:text-gray-300"
                                  >
                                    {t(
                                      'admin.models.fields.nativeWebSearchDynamicFiltering',
                                      'Enable dynamic filtering'
                                    )}
                                  </label>
                                  <p className="text-gray-500 dark:text-gray-400">
                                    {t(
                                      'admin.models.hints.nativeWebSearchDynamicFiltering',
                                      'Runs web search from code execution (Claude 4.6 or later on the Claude API). When off, the newer tool version is called directly.'
                                    )}
                                  </p>
                                </div>
                              </div>
                            </>
                          )}
                      </div>
                    </fieldset>
                  </div>
                )}

                {data.supportsImageGeneration && (
                  <div className="col-span-6">
                    <fieldset>
                      <legend className="text-base font-medium text-gray-900 dark:text-gray-100">
                        {t('admin.models.sections.imageGeneration', 'Image Generation Settings')}
                      </legend>
                      <div className="mt-4 grid grid-cols-6 gap-6">
                        <div className="col-span-6 sm:col-span-3">
                          <label
                            htmlFor="imageGeneration.aspectRatio"
                            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.aspectRatio', 'Aspect Ratio')}
                          </label>
                          <select
                            id="imageGeneration.aspectRatio"
                            value={data.imageGeneration?.aspectRatio || '1:1'}
                            onChange={e =>
                              handleChange('imageGeneration', {
                                ...data.imageGeneration,
                                aspectRatio: e.target.value
                              })
                            }
                            className="mt-1 block w-full py-2 px-3 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                          >
                            <option value="1:1">1:1 (Square)</option>
                            <option value="16:9">16:9 (Landscape)</option>
                            <option value="9:16">9:16 (Portrait)</option>
                            <option value="5:4">5:4</option>
                            <option value="4:5">4:5</option>
                            <option value="3:2">3:2</option>
                            <option value="2:3">2:3</option>
                            <option value="3:4">3:4</option>
                            <option value="4:3">4:3</option>
                            <option value="21:9">21:9 (Ultrawide)</option>
                          </select>
                        </div>

                        <div className="col-span-6 sm:col-span-3">
                          <label
                            htmlFor="imageGeneration.quality"
                            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.imageQuality', 'Image Quality')}
                          </label>
                          <select
                            id="imageGeneration.quality"
                            value={data.imageGeneration?.quality || 'Medium'}
                            onChange={e =>
                              handleChange('imageGeneration', {
                                ...data.imageGeneration,
                                quality: e.target.value
                              })
                            }
                            className="mt-1 block w-full py-2 px-3 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                          >
                            <option value="Low">
                              {t('admin.models.imageQuality.low', 'Low (1K)')}
                            </option>
                            <option value="Medium">
                              {t('admin.models.imageQuality.medium', 'Medium (2K)')}
                            </option>
                            <option value="High">
                              {t('admin.models.imageQuality.high', 'High (4K)')}
                            </option>
                          </select>
                        </div>

                        <div className="col-span-6 sm:col-span-3">
                          <label
                            htmlFor="imageGeneration.maxReferenceImages"
                            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                          >
                            {t('admin.models.fields.maxReferenceImages', 'Max Reference Images')}
                          </label>
                          <input
                            type="number"
                            id="imageGeneration.maxReferenceImages"
                            value={data.imageGeneration?.maxReferenceImages || 14}
                            onChange={e =>
                              handleChange('imageGeneration', {
                                ...data.imageGeneration,
                                maxReferenceImages: parseInt(e.target.value, 10)
                              })
                            }
                            min="1"
                            max="14"
                            className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md"
                          />
                          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.models.hints.maxReferenceImages',
                              'Maximum number of reference images (1-14)'
                            )}
                          </p>
                        </div>
                      </div>
                    </fieldset>
                  </div>
                )}

                {/* Provider-specific configuration (adapter-declared schema). */}
                {providerSchema?.fields?.length > 0 && (
                  <div className="col-span-6">
                    <fieldset>
                      <legend className="text-base font-medium text-gray-900 dark:text-gray-100">
                        {t('admin.models.sections.providerConfig')}
                      </legend>
                      <div className="mt-4 grid grid-cols-6 gap-6">
                        {providerSchema.fields.map(field => {
                          const value =
                            data.config?.[field.key] ??
                            (field.default !== undefined ? field.default : '');
                          const label =
                            (field.label && (field.label[DEFAULT_LANGUAGE] || field.label.en)) ||
                            field.key;
                          const description =
                            field.description &&
                            (field.description[DEFAULT_LANGUAGE] || field.description.en);
                          const inputId = `config.${field.key}`;
                          return (
                            <div key={field.key} className="col-span-6 sm:col-span-3">
                              <label
                                htmlFor={inputId}
                                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                              >
                                {label}
                                {field.required && <span className="text-red-500"> *</span>}
                              </label>
                              {field.type === 'json' ? (
                                <JsonConfigField
                                  id={inputId}
                                  value={data.config?.[field.key]}
                                  onChange={parsed => handleConfigChange(field.key, parsed)}
                                  className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full font-mono text-xs shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md"
                                />
                              ) : Array.isArray(field.enumHint) && field.enumHint.length > 0 ? (
                                <input
                                  id={inputId}
                                  list={`${inputId}-options`}
                                  type="text"
                                  value={value}
                                  onChange={e => handleConfigChange(field.key, e.target.value)}
                                  className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md"
                                />
                              ) : (
                                <input
                                  id={inputId}
                                  type={field.type === 'number' ? 'number' : 'text'}
                                  value={value}
                                  onChange={e =>
                                    handleConfigChange(
                                      field.key,
                                      field.type === 'number'
                                        ? Number(e.target.value)
                                        : e.target.value
                                    )
                                  }
                                  className="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-xs sm:text-sm border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md"
                                />
                              )}
                              {Array.isArray(field.enumHint) && field.enumHint.length > 0 && (
                                <datalist id={`${inputId}-options`}>
                                  {field.enumHint.map(opt => (
                                    <option key={opt} value={opt} />
                                  ))}
                                </datalist>
                              )}
                              {description && (
                                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                                  {description}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </FormValidationProvider>
  );
}

export default ModelFormEditor;
