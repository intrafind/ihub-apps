import { useTranslation } from 'react-i18next';
import ToolsSelector from '../../../../shared/components/ToolsSelector';

/** Whether the model decides to use the app's tools or must call one first. */
function ToolChoiceSelect({ toolChoice, onChange }) {
  const { t } = useTranslation();

  return (
    <div className="mt-6">
      <label
        htmlFor="app-tool-choice"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        {t('admin.apps.edit.toolChoice', 'Tool use')}
      </label>
      <select
        id="app-tool-choice"
        value={toolChoice || 'auto'}
        onChange={e => onChange(e.target.value === 'auto' ? undefined : e.target.value)}
        className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        aria-describedby="app-tool-choice-help"
      >
        <option value="auto">
          {t('admin.apps.edit.toolChoiceAuto', 'Model decides (default)')}
        </option>
        <option value="required">
          {t('admin.apps.edit.toolChoiceRequired', 'Use a tool first')}
        </option>
      </select>
      <p id="app-tool-choice-help" className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.toolChoiceRequiredHelp',
          "The first answer step of every message must call one of the app's tools; the model can then answer from the result. Not every model can be forced by the provider - for those the model is asked in words instead."
        )}
      </p>
    </div>
  );
}

function ToolsConfigSection({
  selectedTools,
  onToolsChange,
  mcpToolIds,
  toolChoice,
  onToolChoiceChange
}) {
  const { t } = useTranslation();

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.tools', 'Tools')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.toolsDesc', 'Configure which tools are available for this app')}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2">
          <ToolsSelector
            selectedTools={selectedTools}
            onToolsChange={onToolsChange}
            excludeToolIds={[
              'braveSearch',
              'qwantSearch',
              'staanSearch',
              'enhancedWebSearch',
              'read_url',
              ...mcpToolIds
            ]}
          />
          <ToolChoiceSelect toolChoice={toolChoice} onChange={onToolChoiceChange} />
        </div>
      </div>
    </div>
  );
}

export default ToolsConfigSection;
