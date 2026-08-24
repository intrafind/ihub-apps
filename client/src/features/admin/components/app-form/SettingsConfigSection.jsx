/**
 * SettingsConfigSection - Toggles controlling which per-chat settings end
 * users are allowed to change, extracted from AppFormEditor.
 *
 * @component
 */
function SettingsConfigSection({ app, onChange, t }) {
  const handleSettingChange = (key, enabled) => {
    onChange({
      ...app,
      settings: {
        ...app.settings,
        [key]: { enabled }
      }
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.settings', 'User Settings')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.settingsDesc', 'Configure which settings users can modify')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.settings?.model?.enabled !== false}
                onChange={e => handleSettingChange('model', e.target.checked)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableModelSelection', 'Enable Model Selection')}
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.settings?.temperature?.enabled !== false}
                onChange={e => handleSettingChange('temperature', e.target.checked)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableTemperatureControl', 'Enable Temperature Control')}
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.settings?.outputFormat?.enabled !== false}
                onChange={e => handleSettingChange('outputFormat', e.target.checked)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableOutputFormat', 'Enable Output Format Selection')}
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.settings?.chatHistory?.enabled !== false}
                onChange={e => handleSettingChange('chatHistory', e.target.checked)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableChatHistory', 'Enable Chat History Control')}
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.settings?.style?.enabled !== false}
                onChange={e => handleSettingChange('style', e.target.checked)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableStyleControl', 'Enable Style Control')}
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsConfigSection;
