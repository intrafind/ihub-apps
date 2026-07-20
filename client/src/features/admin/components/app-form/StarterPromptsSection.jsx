import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../../shared/components/Icon';

/**
 * StarterPromptsSection - Starter prompt list editor for the App form.
 * Extracted from AppFormEditor.jsx (see #1781) as a self-contained slice:
 * owns its own immutable-update handlers since they only ever touch
 * `app.starterPrompts`.
 */
function StarterPromptsSection({ app, onChange }) {
  const { t } = useTranslation();

  const handleStarterPromptChange = (index, field, value) => {
    onChange({
      ...app,
      starterPrompts: app.starterPrompts.map((prompt, i) =>
        i === index ? { ...prompt, [field]: value } : prompt
      )
    });
  };

  const addStarterPrompt = () => {
    onChange({
      ...app,
      starterPrompts: [
        ...(app.starterPrompts || []),
        {
          title: { en: '' },
          message: { en: '' },
          variables: {},
          autoSend: false
        }
      ]
    });
  };

  const removeStarterPrompt = index => {
    onChange({
      ...app,
      starterPrompts: app.starterPrompts.filter((_, i) => i !== index)
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.starterPrompts', 'Starter Prompts')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.starterPromptsDesc',
              'Pre-defined prompts to help users get started'
            )}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            {(app.starterPrompts || []).map((prompt, index) => (
              <div
                key={index}
                className="border border-gray-200 dark:border-gray-600 rounded-lg p-4"
              >
                <div className="flex justify-between items-start mb-4">
                  <h4 className="text-sm font-medium text-gray-900">
                    {t('admin.apps.edit.starterPrompt', 'Starter Prompt')} {index + 1}
                  </h4>
                  <button
                    type="button"
                    onClick={() => removeStarterPrompt(index)}
                    className="text-red-600 hover:text-red-800"
                  >
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-4">
                  <DynamicLanguageEditor
                    label={t('admin.apps.edit.title', 'Title')}
                    value={prompt.title || {}}
                    onChange={value => handleStarterPromptChange(index, 'title', value)}
                    placeholder={{
                      en: 'Enter prompt title in English',
                      de: 'Prompt-Titel auf Deutsch eingeben'
                    }}
                  />

                  <DynamicLanguageEditor
                    label={t('admin.apps.edit.message', 'Message')}
                    value={prompt.message || {}}
                    onChange={value => handleStarterPromptChange(index, 'message', value)}
                    type="textarea"
                    placeholder={{
                      en: 'Enter prompt message in English',
                      de: 'Prompt-Nachricht auf Deutsch eingeben'
                    }}
                  />

                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={prompt.autoSend || false}
                      onChange={e => handleStarterPromptChange(index, 'autoSend', e.target.checked)}
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                      {t('admin.apps.edit.autoSendPrompt', 'Send immediately when clicked')}
                    </label>
                  </div>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={addStarterPrompt}
              className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <Icon name="plus" className="h-4 w-4 mr-2" />
              {t('admin.apps.edit.addStarterPrompt', 'Add Starter Prompt')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StarterPromptsSection;
