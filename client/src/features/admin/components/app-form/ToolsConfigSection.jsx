import { useTranslation } from 'react-i18next';
import ToolsSelector from '../../../../shared/components/ToolsSelector';

function ToolsConfigSection({ selectedTools, onToolsChange, mcpToolIds }) {
  const { t } = useTranslation();

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
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
              'enhancedWebSearch',
              'webContentExtractor',
              ...mcpToolIds
            ]}
          />
        </div>
      </div>
    </div>
  );
}

export default ToolsConfigSection;
