import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';

/**
 * Inline model selector component for next-gen chat input
 * Displays selected model with dropdown for quick model switching
 */
const ModelSelector = ({
  app,
  models,
  selectedModel,
  onModelChange,
  currentLanguage,
  disabled = false
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

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

  // Get current selected model data
  const selectedModelData = filteredModels.find(m => m.id === selectedModel);
  const selectedModelName = selectedModelData
    ? getLocalizedContent(selectedModelData.name, currentLanguage)
    : t('appConfig.selectModel', 'Select Model');

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleModelSelect = modelId => {
    onModelChange(modelId);
    setIsOpen(false);
  };

  // Don't render if disabled by app settings or if only one model available
  if (
    app?.disallowModelSelection ||
    app?.settings?.model?.enabled === false ||
    filteredModels.length <= 1
  ) {
    return null;
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          disabled
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
        }`}
        title={t('appConfig.selectModel', 'Select Model')}
      >
        <span className="max-w-[150px] truncate">{selectedModelName}</span>
        <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size="sm" />
      </button>

      {isOpen && !disabled && (
        <div className="absolute bottom-full left-0 mb-2 w-80 max-h-96 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
          <div className="p-2">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 px-3 py-2">
              {t('appConfig.selectModel', 'Select Model')}
            </div>
            {filteredModels.map(model => {
              const name = getLocalizedContent(model.name, currentLanguage);
              const desc = getLocalizedContent(model.description, currentLanguage);
              const isSelected = model.id === selectedModel;

              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => handleModelSelect(model.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                    isSelected
                      ? 'bg-indigo-50 dark:bg-indigo-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div
                        className={`text-sm font-medium ${
                          isSelected
                            ? 'text-indigo-600 dark:text-indigo-400'
                            : 'text-gray-900 dark:text-gray-100'
                        }`}
                      >
                        {name}
                      </div>
                      {desc && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                          {desc}
                        </div>
                      )}
                    </div>
                    {isSelected && (
                      <Icon
                        name="check"
                        size="sm"
                        className="text-indigo-600 dark:text-indigo-400 flex-shrink-0"
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
