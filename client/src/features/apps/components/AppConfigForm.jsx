import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { fetchToolsBasic } from '../../../api/api';

const AppConfigForm = ({
  app,
  models,
  styles,
  selectedModel,
  selectedStyle,
  selectedOutputFormat,
  sendChatHistory,
  temperature,
  thinkingEnabled,
  thinkingBudget,
  thinkingThoughts,
  enabledTools,
  onModelChange,
  onStyleChange,
  onOutputFormatChange,
  onSendChatHistoryChange,
  onTemperatureChange,
  onThinkingEnabledChange,
  onThinkingBudgetChange,
  onThinkingThoughtsChange,
  onEnabledToolsChange,
  currentLanguage
}) => {
  const { t } = useTranslation();
  const [availableTools, setAvailableTools] = useState([]);
  const [toolsLoading, setToolsLoading] = useState(false);

  // Load tools when component mounts if app has tools
  useEffect(() => {
    const loadTools = async () => {
      if (!app?.tools || app.tools.length === 0) return;

      try {
        setToolsLoading(true);
        const tools = await fetchToolsBasic();
        setAvailableTools(tools || []);
      } catch (error) {
        console.error('Failed to fetch tools:', error);
        setAvailableTools([]);
      } finally {
        setToolsLoading(false);
      }
    };

    loadTools();
  }, [app?.tools]);

  // Filter models if app has allowedModels specified
  const availableModels =
    app?.allowedModels && app.allowedModels.length > 0
      ? models.filter(model => app.allowedModels.includes(model.id))
      : models;

  // Apply additional filters from settings
  let filteredModels = availableModels;

  // Filter by tools requirement
  if (app?.tools && app.tools.length > 0) {
    filteredModels = filteredModels.filter(model => model.supportsTools);
  }

  // Apply model settings filter if specified
  if (app?.settings?.model?.filter) {
    const filter = app.settings.model.filter;
    filteredModels = filteredModels.filter(model => {
      // Check each filter property
      for (const [key, value] of Object.entries(filter)) {
        if (model[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  // Check if selected model supports thinking
  const selectedModelData = models.find(m => m.id === selectedModel);
  const supportsThinking = selectedModelData?.thinking?.enabled === true;

  // Available output formats
  const outputFormats = [
    { id: 'markdown', name: t('appConfig.markdown', 'Markdown') },
    { id: 'text', name: t('appConfig.plainText', 'Plain Text') }
  ];

  // Only show JSON when an outputSchema is configured
  if (app?.outputSchema) {
    outputFormats.push({ id: 'json', name: t('appConfig.json', 'JSON') });
  }

  // If settings are completely disabled, don't show the form
  if (app?.settings?.enabled === false) {
    return (
      <div className="text-center text-gray-500 italic p-4">
        {t('appConfig.settingsDisabled', 'Settings have been disabled for this application.')}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Model Selection */}
      {app?.settings?.model?.enabled !== false && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('appConfig.model', 'Model')}
          </label>
          <select
            value={selectedModel}
            onChange={e => onModelChange(e.target.value)}
            className="w-full p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
          >
            {filteredModels.map(model => {
              const name = getLocalizedContent(model.name, currentLanguage);
              const desc = getLocalizedContent(model.description, currentLanguage);
              return (
                <option key={model.id} value={model.id}>
                  {name}
                  {desc ? ` - ${desc}` : ''}
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* Style Selection */}
      {app?.settings?.style?.enabled !== false && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('responseStyles.title', 'Response Style')}
          </label>
          <select
            value={selectedStyle}
            onChange={e => onStyleChange(e.target.value)}
            className="w-full p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
          >
            {Object.entries(styles).map(([id]) => (
              <option key={id} value={id}>
                {t(`responseStyles.${id}`, id.charAt(0).toUpperCase() + id.slice(1))}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Temperature */}
      {app?.settings?.temperature?.enabled !== false && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('models.temperature')}: {temperature}
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={temperature}
            onChange={e => onTemperatureChange(parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-500">
            <span>{t('common.precise')}</span>
            <span>{t('common.creative')}</span>
          </div>
        </div>
      )}

      {/* Output Format */}
      {app?.settings?.outputFormat?.enabled !== false && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('models.outputFormat', 'Output Format')}
          </label>
          <select
            value={selectedOutputFormat}
            onChange={e => onOutputFormatChange(e.target.value)}
            className="w-full p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
          >
            {outputFormats.map(format => (
              <option key={format.id} value={format.id}>
                {format.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Chat History Toggle */}
      {app?.settings?.chatHistory?.enabled !== false && (
        <div className="flex items-center">
          <label className="flex items-center text-sm font-medium text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={sendChatHistory}
              onChange={e => onSendChatHistoryChange(e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 mr-2"
            />
            {t('appConfig.includeChatHistory', 'Include chat history in requests')}
          </label>
        </div>
      )}

      {/* Thinking Settings - Only show if selected model supports thinking */}
      {supportsThinking && app?.settings?.thinking?.enabled !== false && (
        <>
          <div className="col-span-1 md:col-span-3 mt-4 mb-2">
            <h3 className="text-sm font-semibold text-gray-700">
              {t('appConfig.thinkingSettings', 'Thinking Settings')}
            </h3>
          </div>

          {/* Enable Thinking Toggle */}
          <div className="flex items-center">
            <label className="flex items-center text-sm font-medium text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={thinkingEnabled ?? app?.thinking?.enabled ?? true}
                onChange={e => onThinkingEnabledChange?.(e.target.checked)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 mr-2"
              />
              {t('appConfig.enableThinking', 'Enable thinking mode')}
            </label>
          </div>

          {/* Thinking Budget */}
          {(thinkingEnabled ?? app?.thinking?.enabled ?? true) && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('appConfig.thinkingBudget', 'Thinking Budget')}
                </label>
                <input
                  type="number"
                  min="0"
                  max="32768"
                  step="1024"
                  value={
                    thinkingBudget ??
                    app?.thinking?.budget ??
                    selectedModelData?.thinking?.budget ??
                    8192
                  }
                  onChange={e => onThinkingBudgetChange?.(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('appConfig.thinkingBudgetHelp', 'Maximum tokens for thinking (0 = unlimited)')}
                </p>
              </div>

              {/* Show Thoughts Toggle */}
              <div className="flex items-center">
                <label className="flex items-center text-sm font-medium text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={
                      thinkingThoughts ??
                      app?.thinking?.thoughts ??
                      selectedModelData?.thinking?.thoughts ??
                      true
                    }
                    onChange={e => onThinkingThoughtsChange?.(e.target.checked)}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 mr-2"
                  />
                  {t('appConfig.showThoughts', 'Show thinking process')}
                </label>
              </div>
            </>
          )}
        </>
      )}

      {/* Tools Selection - Only show if app has tools configured */}
      {app?.tools && app.tools.length > 0 && app?.settings?.tools?.enabled !== false && (
        <>
          <div className="col-span-1 md:col-span-3 mt-4 mb-2">
            <h3 className="text-sm font-semibold text-gray-700">
              {t('appConfig.toolsSettings', 'Tools')}
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              {t(
                'appConfig.toolsSettingsHelp',
                'Enable or disable individual tools for this session'
              )}
            </p>
          </div>

          {toolsLoading ? (
            <div className="col-span-1 md:col-span-3 text-sm text-gray-500">
              {t('common.loading', 'Loading...')}
            </div>
          ) : (
            <div className="col-span-1 md:col-span-3 space-y-2">
              {app.tools.map(toolId => {
                const toolInfo = availableTools.find(t => t.id === toolId);
                const toolName = toolInfo?.name || toolId;
                const toolDescription = toolInfo?.description;
                const isEnabled = enabledTools.includes(toolId);

                return (
                  <div
                    key={toolId}
                    className="flex items-start p-2 border border-gray-200 rounded hover:bg-gray-50"
                  >
                    <label className="flex items-start cursor-pointer flex-1">
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={e => {
                          const newEnabledTools = e.target.checked
                            ? [...enabledTools, toolId]
                            : enabledTools.filter(t => t !== toolId);
                          onEnabledToolsChange?.(newEnabledTools);
                        }}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 mt-0.5 mr-3 flex-shrink-0"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-900">{toolName}</div>
                        {toolDescription && (
                          <div className="text-xs text-gray-500 mt-0.5">{toolDescription}</div>
                        )}
                      </div>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AppConfigForm;
