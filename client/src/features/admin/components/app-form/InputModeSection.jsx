import parseNumberOrUndefined from '../../utils/parseNumberOrUndefined';
import { usePlatformConfig } from '../../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import {
  fromDictationValue,
  getPlatformDefaultService,
  getSpeechServiceLabel,
  toDictationValue
} from '../../../voice/utils/speechService';

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
  const recognition = app.settings?.speechRecognition || {};
  const speechService = recognition.service || 'default';
  const selectedModelId = speechService === 'model' ? recognition.modelId || '' : '';
  const selectedModelMissing =
    Boolean(selectedModelId) && !transcriptionModels.some(m => m.id === selectedModelId);
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

/**
 * @param {object} props
 * @param {Array} [props.transcriptionModels] Enabled streaming transcription
 *   models: each one can take the app's voice input.
 */
function InputModeSection({ app, onChange, t, transcriptionModels = [], currentLanguage }) {
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
          </div>
        </div>
      </div>
    </div>
  );
}

export default InputModeSection;
