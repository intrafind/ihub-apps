import { useTranslation } from 'react-i18next';

/**
 * IAssistantSection - iAssistant integration configuration card for the App form.
 * Extracted from AppFormEditor.jsx (see #1781) as a self-contained slice:
 * only ever reads/writes `app.iassistant` via the passed-in onChange.
 */
function IAssistantSection({ app, onChange }) {
  const { t } = useTranslation();

  const handleIAssistantChange = updates => {
    onChange({
      ...app,
      iassistant: {
        ...(app.iassistant || {}),
        ...updates
      }
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.iassistant', 'iAssistant')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.iassistantDesc', 'Configure iAssistant integration for this app')}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-4">
          {/* Enable iAssistant toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.apps.edit.iassistantEnabled', 'Enable iAssistant')}
            </label>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={app.iassistant?.enabled ?? false}
                onChange={e => handleIAssistantChange({ enabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
            </label>
          </div>

          {/* iAssistant settings - only shown when enabled */}
          {app.iassistant?.enabled && (
            <div className="space-y-4 pl-1">
              {/* Profile ID */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.iassistantProfileId', 'Profile ID')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantProfileIdDesc',
                    'The iAssistant profile to use for this app (e.g., iassistant-workspace)'
                  )}
                </p>
                <input
                  type="text"
                  value={app.iassistant?.profileId ?? ''}
                  onChange={e => handleIAssistantChange({ profileId: e.target.value })}
                  placeholder="iassistant-workspace"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>

              {/* Search Profile */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.iassistantSearchProfile', 'Search Profile')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantSearchProfileDesc',
                    'The search profile to use for retrieval using iFinder (e.g., searchprofile-standard)'
                  )}
                </p>
                <input
                  type="text"
                  value={app.iassistant?.searchProfile ?? ''}
                  onChange={e => handleIAssistantChange({ searchProfile: e.target.value })}
                  placeholder="searchprofile-standard"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>

              {/* Extra Context */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.iassistantExtraContext', 'Extra Context')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantExtraContextDesc',
                    'Additional context to be added to the response state prompt. Use with care as changes can impact answer quality.'
                  )}
                </p>
                <textarea
                  value={app.iassistant?.extraContext ?? ''}
                  onChange={e => handleIAssistantChange({ extraContext: e.target.value })}
                  rows={3}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>

              {/* System Prompt Preamble */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.iassistantSystemPromptPreamble', 'System Prompt Preamble')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.iassistantSystemPromptPreambleDesc',
                    'The prompt preamble used in the response state system prompt. This is ideal for changing the identity of the iAssistant. Use with care.'
                  )}
                </p>
                <textarea
                  value={app.iassistant?.systemPromptPreamble ?? ''}
                  onChange={e => handleIAssistantChange({ systemPromptPreamble: e.target.value })}
                  rows={3}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default IAssistantSection;
