import { useTranslation } from 'react-i18next';

/**
 * WebSearchSection - Web search configuration card for the App form.
 * Extracted from AppFormEditor.jsx (see #1781) as a self-contained slice:
 * only ever reads/writes `app.websearch` via the passed-in onChange.
 */
function WebSearchSection({ app, onChange }) {
  const { t } = useTranslation();

  const handleWebSearchChange = updates => {
    onChange({
      ...app,
      websearch: {
        ...(app.websearch || {}),
        ...updates
      }
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.websearch', 'Web Search')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.websearchDesc', 'Configure web search capabilities for this app')}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-4">
          {/* Enable Web Search toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.apps.edit.websearchEnabled', 'Enable Web Search')}
            </label>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={app.websearch?.enabled ?? false}
                onChange={e => handleWebSearchChange({ enabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
            </label>
          </div>

          {/* Web Search settings - only shown when enabled */}
          {app.websearch?.enabled && (
            <div className="space-y-4 pl-1">
              {/* Provider */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.websearchProvider', 'Provider')}
                </label>
                <select
                  value={app.websearch?.provider ?? 'auto'}
                  onChange={e => handleWebSearchChange({ provider: e.target.value })}
                  className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                >
                  <option value="auto">{t('admin.apps.edit.websearchProviderAuto', 'Auto')}</option>
                  <option value="brave">
                    {t('admin.apps.edit.websearchProviderBrave', 'Brave')}
                  </option>
                </select>
              </div>

              {/* Use Native Search */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.websearchUseNative', 'Use Native Search')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.websearchUseNativeDesc',
                      "Use the model's built-in search when available (e.g. Google, OpenAI, Anthropic)"
                    )}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer ml-4">
                  <input
                    type="checkbox"
                    checked={app.websearch?.useNativeSearch ?? true}
                    onChange={e => handleWebSearchChange({ useNativeSearch: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                </label>
              </div>

              {/* Max Results */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.websearchMaxResults', 'Max Results')}
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={app.websearch?.maxResults ?? 5}
                  onChange={e =>
                    handleWebSearchChange({ maxResults: parseInt(e.target.value) || 5 })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              {/* Extract Content */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.websearchExtractContent', 'Extract Content')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.websearchExtractContentDesc',
                      'Fetch and extract full page content from search results'
                    )}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer ml-4">
                  <input
                    type="checkbox"
                    checked={app.websearch?.extractContent ?? true}
                    onChange={e => handleWebSearchChange({ extractContent: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                </label>
              </div>

              {/* Content Max Length */}
              {(app.websearch?.extractContent ?? true) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.websearchContentMaxLength', 'Content Max Length')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.apps.edit.websearchContentMaxLengthDesc',
                      'Maximum characters extracted per page (500–50000)'
                    )}
                  </p>
                  <input
                    type="number"
                    min="500"
                    max="50000"
                    step="500"
                    value={app.websearch?.contentMaxLength ?? 3000}
                    onChange={e =>
                      handleWebSearchChange({
                        contentMaxLength: parseInt(e.target.value) || 3000
                      })
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>
              )}

              {/* Enabled by Default */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.websearchEnabledByDefault', 'Enabled by Default')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.websearchEnabledByDefaultDesc',
                      'Whether web search is turned on by default for users'
                    )}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer ml-4">
                  <input
                    type="checkbox"
                    checked={app.websearch?.enabledByDefault ?? false}
                    onChange={e => handleWebSearchChange({ enabledByDefault: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                </label>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default WebSearchSection;
