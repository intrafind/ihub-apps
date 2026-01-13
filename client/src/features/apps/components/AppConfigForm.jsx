import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';

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
  onModelChange,
  onStyleChange,
  onOutputFormatChange,
  onSendChatHistoryChange,
  onTemperatureChange,
  onThinkingEnabledChange,
  onThinkingBudgetChange,
  onThinkingThoughtsChange,
  currentLanguage
}) => {
  const { t } = useTranslation();

  // Helper function to check if model has required capabilities
  const modelHasRequiredCapabilities = (model, app) => {
    // If app has imageGenerationOptions, it needs image generation capability
    if (app?.imageGenerationOptions) {
      // Only show models that explicitly have imageGeneration capability enabled
      return model.capabilities?.imageGeneration === true;
    }
    
    // For regular text generation apps
    // Show models that either:
    // 1. Have textGeneration explicitly set to true, OR
    // 2. Don't have a capabilities object at all (backward compatibility), OR
    // 3. Have capabilities object but textGeneration is not explicitly false
    if (!model.capabilities) {
      // No capabilities defined - assume it's a text generation model (backward compatibility)
      return true;
    }
    
    // If capabilities exists, check if textGeneration is enabled
    // Default to true if not explicitly set, for backward compatibility
    return model.capabilities.textGeneration !== false;
  };

  // Filter models if app has allowedModels specified
  const availableModels =
    app?.allowedModels && app.allowedModels.length > 0
      ? models.filter(model => app.allowedModels.includes(model.id))
      : models;

  // Filter by capabilities
  const capabilityFilteredModels = availableModels.filter(model => 
    modelHasRequiredCapabilities(model, app)
  );

  // Filter by tool support if needed
  const filteredModels =
    app?.tools && app.tools.length > 0
      ? capabilityFilteredModels.filter(model => model.supportsTools)
      : capabilityFilteredModels;

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
    </div>
  );
};

export default AppConfigForm;
