// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import parseNumberOrUndefined from '../../utils/parseNumberOrUndefined';
import { usePlatformConfig } from '../../../../shared/contexts/PlatformConfigContext';
import useFeatureFlags from '../../../../shared/hooks/useFeatureFlags';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import {
  fromDictationValue,
  getPlatformDefaultService,
  getSpeechServiceLabel,
  toDictationValue
} from '../../../voice/utils/speechService';
import { VOICE_LISTENING_STYLES, withVoiceModeSettings } from '../../utils/voiceMode';

/** The microphone switch and, when it is on, its mode and transcript options. */
function MicrophoneFields({ app, onInputChange: handleInputChange, t }) {
  return (
    <div>
      <div className="flex items-center mb-2">
        <input
          type="checkbox"
          checked={app.inputMode?.microphone?.enabled !== false}
          onChange={e =>
            handleInputChange('inputMode', {
              ...app.inputMode,
              microphone: {
                ...app.inputMode?.microphone,
                enabled: e.target.checked
              }
            })
          }
          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded-sm"
        />
        <label className="ml-2 block text-sm font-medium text-gray-900">
          {t('admin.apps.edit.enableMicrophone', 'Enable Microphone')}
        </label>
      </div>

      {app.inputMode?.microphone?.enabled && (
        <div className="space-y-3 pl-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.apps.edit.microphoneMode', 'Microphone Mode')}
            </label>
            <select
              value={app.inputMode?.microphone?.mode || 'manual'}
              onChange={e =>
                handleInputChange('inputMode', {
                  ...app.inputMode,
                  microphone: { ...app.inputMode?.microphone, mode: e.target.value }
                })
              }
              className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            >
              <option value="manual">
                {t('admin.apps.edit.manualMode', 'Manual (Click to Record)')}
              </option>
              <option value="automatic">
                {t('admin.apps.edit.automaticMode', 'Automatic (Voice Activation)')}
              </option>
            </select>
          </div>

          <div className="flex items-center">
            <input
              type="checkbox"
              checked={app.inputMode?.microphone?.showTranscript !== false}
              onChange={e =>
                handleInputChange('inputMode', {
                  ...app.inputMode,
                  microphone: {
                    ...app.inputMode?.microphone,
                    showTranscript: e.target.checked
                  }
                })
              }
              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded-sm"
            />
            <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
              {t('admin.apps.edit.showTranscript', 'Show Transcript')}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/** What the service picker's value selects: a service, or a model to dictate with. */
const serviceFromValue = value =>
  value === 'default' || value === 'custom'
    ? { service: value, modelId: '' }
    : fromDictationValue(value);

/** The app's speech recognition setting, and the model it dictates with (if any). */
const recognitionOf = (app, transcriptionModels) => {
  const recognition = app.settings?.speechRecognition || {};
  const speechService = recognition.service || 'default';
  const selectedModelId = speechService === 'model' ? recognition.modelId || '' : '';
  const selectedModelMissing =
    Boolean(selectedModelId) && !transcriptionModels.some(m => m.id === selectedModelId);
  return { recognition, speechService, selectedModelId, selectedModelMissing };
};

/** The picker's value for what the app has chosen. */
const pickerValue = (speechService, modelId) =>
  speechService === 'model' ? toDictationValue({ service: 'model', modelId }) : speechService;

/** The default service's name in the "Platform default (…)" option. */
const platformDefaultLabelOf = (platformDefault, modelName, t) =>
  platformDefault.service === 'model'
    ? modelName(platformDefault.modelId)
    : getSpeechServiceLabel(platformDefault.service, t);

/** The streaming transcription models, plus a chosen one that is gone. */
function TranscriptionModelOptions({
  models,
  selectedModelId,
  selectedModelMissing,
  modelName,
  t
}) {
  if (models.length === 0 && !selectedModelMissing) return null;
  return (
    <optgroup label={t('admin.voiceInput.services.models', 'Transcription models')}>
      {models.map(m => (
        <option key={m.id} value={toDictationValue({ service: 'model', modelId: m.id })}>
          {modelName(m.id)}
        </option>
      ))}
      {selectedModelMissing && (
        <option value={toDictationValue({ service: 'model', modelId: selectedModelId })}>
          {selectedModelId}
        </option>
      )}
    </optgroup>
  );
}

/** What the chosen service means for the app. */
function SpeechServiceHint({ speechService, selectedModelMissing, t }) {
  if (speechService === 'default') {
    return (
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.platformDefaultServiceHint',
          'Follows the default set under Admin → Voice Input, including later changes.'
        )}
      </p>
    );
  }
  if (speechService !== 'model') return null;
  if (selectedModelMissing) {
    return (
      <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
        {t(
          'admin.apps.edit.dictationModelUnavailable',
          'This model is disabled, no longer exists or does not stream, so voice input fails in this app.'
        )}
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
      {t(
        'admin.apps.edit.dictationModelHint',
        'The microphone streams through the iHub server to this transcription model. Users need access to the model through their groups.'
      )}
    </p>
  );
}

/**
 * Which speech recognition the app's microphone uses.
 *
 * @param {object} props
 * @param {Array} [props.transcriptionModels] Enabled streaming transcription
 *   models: each one can take the app's voice input.
 */
function SpeechServiceField({
  app,
  onInputChange: handleInputChange,
  t,
  transcriptionModels = [],
  currentLanguage
}) {
  const { platformConfig } = usePlatformConfig();
  const { recognition, speechService, selectedModelId, selectedModelMissing } = recognitionOf(
    app,
    transcriptionModels
  );
  const modelName = id =>
    getLocalizedContent(transcriptionModels.find(m => m.id === id)?.name, currentLanguage) || id;
  const platformDefault = getPlatformDefaultService(platformConfig?.speech);

  const handleServiceChange = value => {
    const { service, modelId } = serviceFromValue(value);
    const { modelId: _previousModel, ...rest } = recognition;
    handleInputChange('settings', {
      ...app.settings,
      speechRecognition: { ...rest, service, ...(service === 'model' ? { modelId } : {}) }
    });
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('admin.apps.edit.speechRecognitionService', 'Speech Recognition Service')}
      </label>
      <select
        value={pickerValue(speechService, selectedModelId)}
        onChange={e => handleServiceChange(e.target.value)}
        className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
      >
        <option value="default">
          {t('admin.apps.edit.platformDefaultService', 'Platform default ({{service}})', {
            service: platformDefaultLabelOf(platformDefault, modelName, t)
          })}
        </option>
        <option value="browser">
          {t('admin.apps.edit.browserService', 'Browser (Web Speech API)')}
        </option>
        <option value="azure">{t('admin.apps.edit.azureService', 'Azure Speech')}</option>
        <TranscriptionModelOptions
          models={transcriptionModels}
          selectedModelId={selectedModelId}
          selectedModelMissing={selectedModelMissing}
          modelName={modelName}
          t={t}
        />
        <option value="custom">{t('admin.apps.edit.customService', 'Custom Service')}</option>
      </select>
      <SpeechServiceHint
        speechService={speechService}
        selectedModelMissing={selectedModelMissing}
        t={t}
      />
    </div>
  );
}

/** Rows of the input box, for a multi-line input. */
function TextareaRowsField({ app, onInputChange: handleInputChange, t }) {
  if (app.inputMode?.type !== 'multiline') return null;
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('admin.apps.edit.textareaRows', 'Textarea Rows')}
      </label>
      <input
        type="number"
        min="1"
        max="20"
        value={app.inputMode?.rows || 5}
        onChange={e =>
          handleInputChange('inputMode', {
            ...app.inputMode,
            rows: parseNumberOrUndefined(e.target.value, Number.parseInt)
          })
        }
        className="mt-1 block w-20 rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
      />
    </div>
  );
}

/** The host of a custom or Azure speech service. */
function ServiceHostField({ app, onInputChange: handleInputChange, t }) {
  const recognition = app.settings?.speechRecognition;
  if (recognition?.service !== 'custom' && recognition?.service !== 'azure') return null;
  return (
    <div className="pl-6">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('admin.apps.edit.customServiceHost', 'Custom Service Host')}
      </label>
      <input
        type="url"
        value={recognition.host || ''}
        onChange={e =>
          handleInputChange('settings', {
            ...app.settings,
            speechRecognition: { ...recognition, host: e.target.value }
          })
        }
        placeholder="https://your-speech-service.com"
        className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
      />
    </div>
  );
}

/** The voice ids a text-to-speech model names, to suggest in the voice field. */
const voiceSuggestionsOf = model => {
  const ids = [model?.tts?.voice, ...Object.values(model?.tts?.voices || {})];
  return [...new Set(ids.filter(id => typeof id === 'string' && id))];
};

const selectClass =
  'mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm disabled:cursor-not-allowed';

/**
 * Whether this app offers the spoken conversation (voice mode), and what it
 * does differently from the platform. Stored in `inputMode.voiceMode`: nothing
 * is written for a setting that follows the platform, and the whole object is
 * left out when no setting is made.
 *
 * @param {object} props
 * @param {Array|null} [props.ttsModels] Enabled text-to-speech models (null until loaded).
 */
function VoiceModeFields({
  app,
  onInputChange: handleInputChange,
  t,
  ttsModels = null,
  currentLanguage
}) {
  const { platformConfig } = usePlatformConfig();
  const flagEnabled = useFeatureFlags().isEnabled('voiceMode', false);
  const voiceListId = useId();
  // Same rule as the runtime: voice mode is part of voice input.
  const micEnabled = (app.inputMode?.microphone?.enabled ?? app.microphone?.enabled) !== false;
  const voiceMode = app.inputMode?.voiceMode || {};
  const choice =
    voiceMode.enabled === true ? 'on' : voiceMode.enabled === false ? 'off' : 'platform';
  const platformVoiceMode = platformConfig?.speech?.voiceMode;
  const platformDefaultLabel =
    typeof platformVoiceMode?.appDefault !== 'boolean'
      ? t('admin.apps.edit.voiceMode.platformDefault', 'Platform default')
      : platformVoiceMode.appDefault
        ? t('admin.apps.edit.voiceMode.platformDefaultOn', 'Platform default (on)')
        : t('admin.apps.edit.voiceMode.platformDefaultOff', 'Platform default (off)');

  const setVoiceMode = patch =>
    handleInputChange('inputMode', withVoiceModeSettings(app.inputMode, patch));

  const modelName = model => getLocalizedContent(model.name, currentLanguage) || model.id;
  const ttsModelId = voiceMode.ttsModelId || '';
  const models = ttsModels || [];
  const chosenModelListed = models.some(m => m.id === ttsModelId);
  // Only a loaded list can say the model is gone; until then it is just not known.
  const chosenModelMissing = Array.isArray(ttsModels) && Boolean(ttsModelId) && !chosenModelListed;
  const effectiveModelId =
    ttsModelId || platformVoiceMode?.ttsModelId || platformConfig?.speech?.tts?.defaultModelId;
  const voiceSuggestions = voiceSuggestionsOf(models.find(m => m.id === effectiveModelId));
  const platformModel = models.find(
    m => m.id === (platformVoiceMode?.ttsModelId || platformConfig?.speech?.tts?.defaultModelId)
  );
  const platformStyle = VOICE_LISTENING_STYLES.includes(platformVoiceMode?.listeningStyle)
    ? platformVoiceMode.listeningStyle
    : null;
  const styleName = style =>
    style === 'push-to-talk'
      ? t('admin.apps.edit.voiceMode.pushToTalk', 'Push-to-talk')
      : t('admin.apps.edit.voiceMode.handsFree', 'Hands-free');

  return (
    <div className="space-y-3 border-t border-gray-100 dark:border-gray-700 pt-4">
      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.apps.edit.voiceMode.title', 'Voice mode')}
        </h4>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.apps.edit.voiceMode.description',
            'A spoken conversation with this app: users talk and the app answers out loud. It listens with the speech recognition service above and speaks with a text-to-speech model.'
          )}
        </p>
      </div>

      {!micEnabled && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="voice-mode-mic-off">
          {t(
            'admin.apps.edit.voiceMode.needsMicrophone',
            'Voice mode needs voice input. Enable the microphone above to use it in this app.'
          )}
        </p>
      )}
      {micEnabled && !flagEnabled && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="voice-mode-flag-off">
          {t(
            'admin.apps.edit.voiceMode.flagOff',
            'Voice mode is a preview feature that is switched off under Admin → Features. These settings take effect once it is on.'
          )}
        </p>
      )}

      <fieldset
        disabled={!micEnabled}
        className={`space-y-3 min-w-0 ${micEnabled ? '' : 'opacity-50'}`}
      >
        <div>
          <label
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            htmlFor="voice-mode-choice"
          >
            {t('admin.apps.edit.voiceMode.label', 'Voice mode')}
          </label>
          <select
            id="voice-mode-choice"
            value={choice}
            onChange={e =>
              setVoiceMode({
                enabled:
                  e.target.value === 'on' ? true : e.target.value === 'off' ? false : undefined
              })
            }
            className={selectClass}
          >
            <option value="platform">{platformDefaultLabel}</option>
            <option value="on">{t('admin.apps.edit.voiceMode.on', 'On')}</option>
            <option value="off">{t('admin.apps.edit.voiceMode.off', 'Off')}</option>
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {choice === 'platform'
              ? t(
                  'admin.apps.edit.voiceMode.defaultHint',
                  'Follows the setting under Admin → Voice Input, including later changes.'
                )
              : choice === 'on'
                ? t(
                    'admin.apps.edit.voiceMode.onHint',
                    'On for this app. Voice mode must also be switched on under Admin → Voice Input.'
                  )
                : t('admin.apps.edit.voiceMode.offHint', 'Voice mode is not offered in this app.')}
          </p>
        </div>

        {choice !== 'off' && (
          <div className="space-y-3 pl-6">
            <div>
              <label
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                htmlFor="voice-mode-listening-style"
              >
                {t('admin.apps.edit.voiceMode.listeningStyle', 'Listening style')}
              </label>
              <select
                id="voice-mode-listening-style"
                value={voiceMode.listeningStyle || ''}
                onChange={e => setVoiceMode({ listeningStyle: e.target.value || undefined })}
                className={selectClass}
              >
                <option value="">
                  {platformStyle
                    ? t(
                        'admin.apps.edit.voiceMode.platformDefaultNamed',
                        'Platform default ({{value}})',
                        { value: styleName(platformStyle) }
                      )
                    : t('admin.apps.edit.voiceMode.platformDefault', 'Platform default')}
                </option>
                {VOICE_LISTENING_STYLES.map(style => (
                  <option key={style} value={style}>
                    {styleName(style)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                htmlFor="voice-mode-tts-model"
              >
                {t('admin.apps.edit.voiceMode.ttsModel', 'Text-to-speech model')}
              </label>
              <select
                id="voice-mode-tts-model"
                value={ttsModelId}
                onChange={e => setVoiceMode({ ttsModelId: e.target.value || undefined })}
                className={selectClass}
              >
                <option value="">
                  {platformModel
                    ? t(
                        'admin.apps.edit.voiceMode.platformDefaultNamed',
                        'Platform default ({{value}})',
                        { value: modelName(platformModel) }
                      )
                    : t('admin.apps.edit.voiceMode.platformDefault', 'Platform default')}
                </option>
                {Boolean(ttsModelId) && !chosenModelListed && (
                  <option value={ttsModelId}>{ttsModelId}</option>
                )}
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {modelName(m)}
                  </option>
                ))}
              </select>
              <p
                className={`mt-1 text-xs ${
                  chosenModelMissing
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {chosenModelMissing
                  ? t(
                      'admin.apps.edit.voiceMode.ttsModelUnavailable',
                      'This model is disabled or no longer exists, so voice mode is not offered in this app.'
                    )
                  : t(
                      'admin.apps.edit.voiceMode.ttsModelHint',
                      'For example a German voice model for a German app. Users need access to the model through their groups.'
                    )}
              </p>
            </div>

            <div>
              <label
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                htmlFor="voice-mode-voice"
              >
                {t('admin.apps.edit.voiceMode.voice', 'Voice')}
              </label>
              <input
                id="voice-mode-voice"
                type="text"
                list={voiceListId}
                value={voiceMode.voice || ''}
                onChange={e =>
                  setVoiceMode({ voice: e.target.value.trim() ? e.target.value : undefined })
                }
                placeholder={t('admin.apps.edit.voiceMode.voicePlaceholder', 'Voice of the model')}
                className={selectClass}
              />
              <datalist id={voiceListId}>
                {voiceSuggestions.map(id => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.apps.edit.voiceMode.voiceHint',
                  'Optional voice id of the text-to-speech model. Empty uses the voice settings of the model.'
                )}
              </p>
            </div>
          </div>
        )}
      </fieldset>
    </div>
  );
}

/**
 * @param {object} props
 * @param {Array} [props.transcriptionModels] Enabled streaming transcription
 *   models: each one can take the app's voice input.
 * @param {Array|null} [props.ttsModels] Enabled text-to-speech models: each one can
 *   speak the app's voice mode (null until loaded).
 */
function InputModeSection({
  app,
  onChange,
  t,
  transcriptionModels = [],
  ttsModels = null,
  currentLanguage
}) {
  const handleInputChange = (field, value) => {
    onChange({ ...app, [field]: value });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.inputMode', 'Input Mode & Microphone')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.inputModeDesc', 'Configure input methods and voice recognition')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.inputType', 'Input Type')}
              </label>
              <select
                value={app.inputMode?.type || 'multiline'}
                onChange={e =>
                  handleInputChange('inputMode', { ...app.inputMode, type: e.target.value })
                }
                className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              >
                <option value="singleline">{t('admin.apps.edit.singleLine', 'Single Line')}</option>
                <option value="multiline">{t('admin.apps.edit.multiLine', 'Multi Line')}</option>
              </select>
            </div>

            <TextareaRowsField app={app} onInputChange={handleInputChange} t={t} />

            <MicrophoneFields app={app} onInputChange={handleInputChange} t={t} />

            <SpeechServiceField
              app={app}
              onInputChange={handleInputChange}
              t={t}
              transcriptionModels={transcriptionModels}
              currentLanguage={currentLanguage}
            />

            <ServiceHostField app={app} onInputChange={handleInputChange} t={t} />

            <VoiceModeFields
              app={app}
              onInputChange={handleInputChange}
              t={t}
              ttsModels={ttsModels}
              currentLanguage={currentLanguage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default InputModeSection;
