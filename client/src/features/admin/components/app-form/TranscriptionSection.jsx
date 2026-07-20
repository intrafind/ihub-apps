import { getLocalizedContent } from '../../../../utils/localizeContent';

function TranscriptionSection({
  app,
  onChange,
  t,
  currentLanguage,
  transcriptionModels,
  parseNumberOrUndefined
}) {
  const handleTranscriptionChange = updates =>
    onChange('transcription', { ...app.transcription, ...updates });

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.transcription', 'Transcription')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.transcriptionDesc',
              'Transcribe uploaded audio, uploaded video, or a browser recording with a self-hosted transcription model (e.g. Voxtral) and render the result as a chat answer.'
            )}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.transcription?.enabled || false}
                onChange={e => handleTranscriptionChange({ enabled: e.target.checked })}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableTranscription', 'Enable transcription')}
              </label>
            </div>

            {app.transcription?.enabled && (
              <div className="space-y-4 pl-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={app.transcription?.defaultEnabled !== false}
                    onChange={e => handleTranscriptionChange({ defaultEnabled: e.target.checked })}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-700 dark:text-gray-300">
                    {t(
                      'admin.apps.edit.transcriptionDefaultEnabled',
                      'On by default (users can toggle it per chat)'
                    )}
                  </label>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.transcriptionModel', 'Transcription model')}
                  </label>
                  <select
                    value={app.transcription?.modelId || ''}
                    onChange={e => handleTranscriptionChange({ modelId: e.target.value })}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-sm dark:bg-gray-700 dark:border-gray-600"
                  >
                    <option value="">
                      {t('admin.apps.edit.selectTranscriptionModel', 'Select a model…')}
                    </option>
                    {transcriptionModels.map(m => (
                      <option key={m.id} value={m.id}>
                        {getLocalizedContent(m.name, currentLanguage) || m.id}
                      </option>
                    ))}
                  </select>
                  {transcriptionModels.length === 0 && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      {t(
                        'admin.apps.edit.noTranscriptionModels',
                        'No transcription models configured. Add one under Admin → Models (model type "transcription").'
                      )}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.apps.edit.transcriptionInputs', 'Input sources')}
                  </label>
                  <div className="space-y-2">
                    {[
                      ['upload', t('admin.apps.edit.transcriptionUpload', 'Audio upload')],
                      ['video', t('admin.apps.edit.transcriptionVideo', 'Video upload')],
                      ['record', t('admin.apps.edit.transcriptionRecord', 'Record audio')]
                    ].map(([key, label]) => (
                      <div key={key} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={app.transcription?.inputs?.[key] !== false}
                          onChange={e =>
                            handleTranscriptionChange({
                              inputs: { ...app.transcription?.inputs, [key]: e.target.checked }
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700 dark:text-gray-300">
                          {label}
                        </label>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.transcriptionInputsHint',
                      'Audio/video upload also requires the matching upload toggle under Upload Configuration.'
                    )}
                  </p>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={app.transcription?.streaming !== false}
                    onChange={e => handleTranscriptionChange({ streaming: e.target.checked })}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-700 dark:text-gray-300">
                    {t(
                      'admin.apps.edit.transcriptionStreaming',
                      'Stream transcript as it is produced'
                    )}
                  </label>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.transcriptionMaxDuration', 'Max duration (seconds)')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="7200"
                    value={app.transcription?.maxDurationSeconds || 900}
                    onChange={e =>
                      handleTranscriptionChange({
                        maxDurationSeconds: parseNumberOrUndefined(e.target.value, parseInt)
                      })
                    }
                    className="mt-1 block w-24 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-xs dark:bg-gray-700 dark:border-gray-600"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TranscriptionSection;
