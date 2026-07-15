import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../../utils/localizeContent';

/**
 * MagicPromptSection - Magic Prompt (AI-powered prompt enhancement) configuration
 * card for the App form. Extracted from AppFormEditor.jsx (see #1781) as a
 * self-contained slice: only ever reads/writes `app.features.magicPrompt` via
 * the passed-in onChange.
 */
function MagicPromptSection({ app, onChange, availableModels = [] }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;

  const handleMagicPromptChange = updates => {
    onChange({
      ...app,
      features: {
        ...app.features,
        magicPrompt: { ...app.features?.magicPrompt, ...updates }
      }
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.magicPrompt', 'Magic Prompt')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.magicPromptDesc', 'AI-powered prompt enhancement feature')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.features?.magicPrompt?.enabled || false}
                onChange={e => handleMagicPromptChange({ enabled: e.target.checked })}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableMagicPrompt', 'Enable Magic Prompt')}
              </label>
            </div>

            {app.features?.magicPrompt?.enabled && (
              <div className="space-y-4 pl-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.magicPromptModel', 'Magic Prompt Model')}
                  </label>
                  <select
                    value={app.features?.magicPrompt?.model || ''}
                    onChange={e => handleMagicPromptChange({ model: e.target.value || undefined })}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="">{t('admin.apps.edit.selectModel', 'Select model...')}</option>
                    {availableModels.map(model => (
                      <option key={model.id} value={model.id}>
                        {getLocalizedContent(model.name, currentLanguage)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.magicPromptInstructions', 'Magic Prompt Instructions')}
                  </label>
                  <textarea
                    value={
                      app.features?.magicPrompt?.prompt ||
                      'You are a helpful assistant that improves user prompts to be more specific and effective. Improve this prompt: {{prompt}}'
                    }
                    onChange={e => handleMagicPromptChange({ prompt: e.target.value })}
                    rows={3}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                    placeholder="Enter instructions for the magic prompt feature..."
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.magicPromptPlaceholder',
                      "Use {{prompt}} to reference the user's original prompt"
                    )}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default MagicPromptSection;
