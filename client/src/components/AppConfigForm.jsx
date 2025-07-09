import React from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';

const AppConfigForm = ({ 
  app, 
  models, 
  styles, 
  selectedModel, 
  selectedStyle, 
  selectedOutputFormat,
  sendChatHistory,
  temperature,
  onModelChange, 
  onStyleChange,
  onOutputFormatChange,
  onSendChatHistoryChange, 
  onTemperatureChange,
  currentLanguage 
}) => {
  const { t } = useTranslation();
  
  // Filter models if app has allowedModels specified
  const availableModels = app?.allowedModels && app.allowedModels.length > 0
    ? models.filter(model => app.allowedModels.includes(model.id))
    : models;

  const filteredModels = app?.tools && app.tools.length > 0
    ? availableModels.filter(model => model.supportsTools)
    : availableModels;

  // Available output formats
  const outputFormats = [
    { id: 'markdown', name: t('appConfig.markdown', 'Markdown') },
    { id: 'text', name: t('appConfig.plainText', 'Plain Text') },
    { id: 'json', name: t('appConfig.json', 'JSON') }
  ];

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
      {(app?.settings?.model?.enabled !== false) && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('appConfig.model', 'Model')}
          </label>
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            className="w-full p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
          >
            {filteredModels.map((model) => {
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
      {(app?.settings?.style?.enabled !== false) && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('responseStyles.title', 'Response Style')}
          </label>
          <select
            value={selectedStyle}
            onChange={(e) => onStyleChange(e.target.value)}
            className="w-full p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
          >
            {Object.entries(styles).map(([id, description]) => (
              <option key={id} value={id}>
                {t(`responseStyles.${id}`, id.charAt(0).toUpperCase() + id.slice(1))}
              </option>
            ))}
          </select>
        </div>
      )}
      
      {/* Temperature */}
      {(app?.settings?.temperature?.enabled !== false) && (
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
            onChange={(e) => onTemperatureChange(parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-500">
            <span>{t('common.precise')}</span>
            <span>{t('common.creative')}</span>
          </div>
        </div>
      )}

      {/* Output Format */}
      {(app?.settings?.outputFormat?.enabled !== false) && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('models.outputFormat', 'Output Format')}
          </label>
          <select
            value={selectedOutputFormat}
            onChange={(e) => onOutputFormatChange(e.target.value)}
            className="w-full p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
          >
            {outputFormats.map((format) => (
              <option key={format.id} value={format.id}>
                {format.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Chat History Toggle */}
      {(app?.settings?.chatHistory?.enabled !== false) && (
        <div className="flex items-center">
          <label className="flex items-center text-sm font-medium text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={sendChatHistory}
              onChange={(e) => onSendChatHistoryChange(e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 mr-2"
            />
            {t('appConfig.includeChatHistory', 'Include chat history in requests')}
          </label>
        </div>
      )}
    </div>
  );
};

export default AppConfigForm;