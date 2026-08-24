import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';

/**
 * SystemInstructionsSection - System prompt, message placeholder and prompt template
 * editor for chat apps, extracted from AppFormEditor.
 *
 * @component
 */
function SystemInstructionsSection({ app, onChange, t, validationErrors = {} }) {
  const handleLocalizedChange = (field, value) => {
    onChange({
      ...app,
      [field]: value
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.systemInstructions', 'System Instructions')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.systemInstructionsDesc',
              'System prompts that define the app behavior'
            )}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <DynamicLanguageEditor
            label={
              <span>
                {t('admin.apps.edit.systemInstructions', 'System Instructions')}
                <span className="text-red-500 ml-1">*</span>
              </span>
            }
            value={app.system || {}}
            onChange={value => handleLocalizedChange('system', value)}
            type="textarea"
            placeholder={{
              en: 'Enter system instructions in English',
              de: 'Systeminstruktionen auf Deutsch eingeben'
            }}
            className="mb-6"
            error={validationErrors.system}
            name="system"
          />

          <DynamicLanguageEditor
            label={t('admin.apps.edit.messagePlaceholder', 'Message Placeholder')}
            value={app.messagePlaceholder || {}}
            onChange={value => handleLocalizedChange('messagePlaceholder', value)}
            placeholder={{
              en: 'Enter message placeholder in English',
              de: 'Nachrichtenplatzhalter auf Deutsch eingeben'
            }}
            className="mb-6"
          />

          <DynamicLanguageEditor
            label={t('admin.apps.edit.prompt', 'Prompt Template')}
            value={app.prompt || {}}
            onChange={value => handleLocalizedChange('prompt', value)}
            type="textarea"
            placeholder={{
              en: 'Enter prompt template in English',
              de: 'Prompt-Vorlage auf Deutsch eingeben'
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default SystemInstructionsSection;
