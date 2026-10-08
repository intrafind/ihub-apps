import parseNumberOrUndefined from '../../utils/parseNumberOrUndefined';
import { usePlatformConfig } from '../../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import {
  fromDictationValue,
  getPlatformDefaultService,
  getSpeechServiceLabel,
  toDictationValue
} from '../../../voice/utils/speechService';

/**
 * @param {object} props
 * @param {Array} [props.transcriptionModels] Enabled transcription models: each
 *   one can take the app's voice input.
 */
function InputModeSection({ app, onChange, t, transcriptionModels = [], currentLanguage }) {
  const { platformConfig } = usePlatformConfig();
  const handleInputChange = (field, value) => {
    onChange({ ...app, [field]: value });
  };
  const recognition = app.settings?.speechRecognition || {};
  const speechService = recognition.service || 'default';
  const selectedModelId = speechService === 'model' ? recognition.modelId || '' : '';
  const selectedModelMissing =
    !!selectedModelId && !transcriptionModels.some(m => m.id === selectedModelId);
  const modelName = id =>
    getLocalizedContent(transcriptionModels.find(m => m.id === id)?.name, currentLanguage) || id;
  const platformDefault = getPlatformDefaultService(platformConfig?.speech);
  const platformDefaultLabel =
    platformDefault.service === 'model'
      ? modelName(platformDefault.modelId)
      : getSpeechServiceLabel(platformDefault.service, t);

  const handleServiceChange = value => {
    const { service, modelId } =
      value === 'default' || value === 'custom'
        ? { service: value, modelId: '' }
        : fromDictationValue(value);
    const { modelId: _previousModel, ...rest } = recognition;
    handleInputChange('settings', {
      ...app.settings,
      speechRecognition: { ...rest, service, ...(service === 'model' ? { modelId } : {}) }
    });
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

            {app.inputMode?.type === 'multiline' && (
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
            )}

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

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.speechRecognitionService', 'Speech Recognition Service')}
              </label>
              <select
                value={
                  speechService === 'model'
                    ? toDictationValue({ service: 'model', modelId: selectedModelId })
                    : speechService
                }
                onChange={e => handleServiceChange(e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              >
                <option value="default">
                  {t('admin.apps.edit.platformDefaultService', 'Platform default ({{service}})', {
                    service: platformDefaultLabel
                  })}
                </option>
                <option value="browser">
                  {t('admin.apps.edit.browserService', 'Browser (Web Speech API)')}
                </option>
                <option value="azure">{t('admin.apps.edit.azureService', 'Azure Speech')}</option>
                {(transcriptionModels.length > 0 || selectedModelMissing) && (
                  <optgroup label={t('admin.voiceInput.services.models', 'Transcription models')}>
                    {transcriptionModels.map(m => (
                      <option
                        key={m.id}
                        value={toDictationValue({ service: 'model', modelId: m.id })}
                      >
                        {modelName(m.id)}
                      </option>
                    ))}
                    {selectedModelMissing && (
                      <option
                        value={toDictationValue({ service: 'model', modelId: selectedModelId })}
                      >
                        {selectedModelId}
                      </option>
                    )}
                  </optgroup>
                )}
                <option value="custom">
                  {t('admin.apps.edit.customService', 'Custom Service')}
                </option>
              </select>
              {speechService === 'default' && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.apps.edit.platformDefaultServiceHint',
                    'Follows the default set under Admin → Voice Input, including later changes.'
                  )}
                </p>
              )}
              {speechService === 'model' && (
                <p
                  className={`mt-1 text-xs ${
                    selectedModelMissing
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {selectedModelMissing
                    ? t(
                        'admin.apps.edit.dictationModelUnavailable',
                        'This model is disabled or no longer exists, so voice input fails in this app.'
                      )
                    : t(
                        'admin.apps.edit.dictationModelHint',
                        'The microphone streams through the iHub server to this transcription model. Users need access to the model through their groups.'
                      )}
                </p>
              )}
            </div>

            {(app.settings?.speechRecognition?.service === 'custom' ||
              app.settings?.speechRecognition?.service === 'azure') && (
              <div className="pl-6">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.customServiceHost', 'Custom Service Host')}
                </label>
                <input
                  type="url"
                  value={app.settings?.speechRecognition?.host || ''}
                  onChange={e =>
                    handleInputChange('settings', {
                      ...app.settings,
                      speechRecognition: {
                        ...app.settings?.speechRecognition,
                        host: e.target.value
                      }
                    })
                  }
                  placeholder="https://your-speech-service.com"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default InputModeSection;
