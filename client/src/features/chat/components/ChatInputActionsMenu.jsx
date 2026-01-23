import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchToolsBasic } from '../../../api/api';
import { VoiceInputComponent } from '../../voice/components';
import MagicPromptLoader from '../../../shared/components/MagicPromptLoader';
import { trackToolUsage } from '../../../utils/toolUsageTracker';

/**
 * ChatInputActionsMenu component - unified menu for all chat input actions
 * Consolidates tools, file upload, magic prompt, and voice input into one menu
 * Supports single action optimization and tool usage tracking
 */
const ChatInputActionsMenu = ({
  app,
  enabledTools,
  onEnabledToolsChange,
  // Upload props
  uploadConfig,
  onToggleUploader,
  disabled,
  isProcessing,
  // Magic prompt props
  magicPromptEnabled,
  onMagicPrompt,
  showUndoMagicPrompt,
  onUndoMagicPrompt,
  magicPromptLoading,
  // Voice props
  onVoiceInput,
  onVoiceCommand,
  inputRef
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [availableTools, setAvailableTools] = useState([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [expandedDescriptions, setExpandedDescriptions] = useState({});
  const dropdownRef = useRef(null);

  // Tool grouping configuration
  const TOOL_GROUPS = {
    webSearch: {
      id: 'webSearch',
      name: { en: 'Web Search', de: 'Websuche' },
      description: {
        en: 'Search the web for information',
        de: 'Im Web nach Informationen suchen'
      },
      tools: ['googleSearch', 'webSearch', 'enhancedWebSearch', 'braveSearch', 'tavilySearch']
    }
  };

  // Load tools when component mounts
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

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Get grouped and individual tools
  const getToolsStructure = () => {
    if (!app?.tools || app.tools.length === 0) return { grouped: [], individual: [] };

    const grouped = [];
    const individual = [];
    const processedTools = new Set();

    // Check for tool groups
    Object.values(TOOL_GROUPS).forEach(group => {
      const groupTools = app.tools.filter(toolId => group.tools.includes(toolId));
      if (groupTools.length > 0) {
        grouped.push({
          ...group,
          matchedTools: groupTools
        });
        groupTools.forEach(t => processedTools.add(t));
      }
    });

    // Add remaining individual tools
    app.tools.forEach(toolId => {
      if (!processedTools.has(toolId)) {
        individual.push(toolId);
      }
    });

    return { grouped, individual };
  };

  const { grouped, individual } = getToolsStructure();

  const toggleTool = (toolId, isGroup = false, groupTools = []) => {
    if (isGroup) {
      const allEnabled = groupTools.every(t => enabledTools.includes(t));
      let newEnabledTools;

      if (allEnabled) {
        newEnabledTools = enabledTools.filter(t => !groupTools.includes(t));
        // Track usage for each tool in the group
        groupTools.forEach(tool => trackToolUsage(app.id, tool, false));
      } else {
        const toAdd = groupTools.filter(t => !enabledTools.includes(t));
        newEnabledTools = [...enabledTools, ...toAdd];
        // Track usage for each newly enabled tool
        toAdd.forEach(tool => trackToolUsage(app.id, tool, true));
      }

      onEnabledToolsChange?.(newEnabledTools);
    } else {
      const isEnabled = enabledTools.includes(toolId);
      const newEnabledTools = isEnabled
        ? enabledTools.filter(t => t !== toolId)
        : [...enabledTools, toolId];

      // Track this tool usage
      trackToolUsage(app.id, toolId, !isEnabled);

      onEnabledToolsChange?.(newEnabledTools);
    }
  };

  const hasTools = app?.tools && app.tools.length > 0;
  const toolCount = app?.tools?.length || 0;
  const enabledCount = hasTools ? app.tools.filter(t => enabledTools.includes(t)).length : 0;

  // Count quick actions (non-tools actions)
  const quickActionCount =
    (uploadConfig?.enabled === true ? 1 : 0) +
    (magicPromptEnabled && !showUndoMagicPrompt ? 1 : 0) +
    (showUndoMagicPrompt ? 1 : 0) +
    (onVoiceInput ? 1 : 0);

  // Check if we have any actions to show
  const hasActions = hasTools || quickActionCount > 0;

  if (!hasActions) return null;

  // Single action optimization: if we have exactly one action and no tools,
  // render that action directly without a menu
  const totalActions = quickActionCount + (hasTools ? 1 : 0);

  if (totalActions === 1 && quickActionCount === 1 && !hasTools) {
    // Render the single action directly
    if (uploadConfig?.enabled === true) {
      return (
        <button
          type="button"
          onClick={onToggleUploader}
          disabled={disabled || isProcessing}
          title={t('chatActions.attachFile', 'Attach File')}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <Icon name="paper-clip" size="md" />
        </button>
      );
    }

    if (magicPromptEnabled && !showUndoMagicPrompt) {
      return (
        <button
          type="button"
          onClick={onMagicPrompt}
          disabled={disabled || isProcessing}
          title={t('common.magicPrompt', 'Magic Prompt')}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          {magicPromptLoading ? <MagicPromptLoader /> : <Icon name="sparkles" size="md" />}
        </button>
      );
    }

    if (showUndoMagicPrompt) {
      return (
        <button
          type="button"
          onClick={onUndoMagicPrompt}
          disabled={disabled || isProcessing}
          title={t('common.undo', 'Undo')}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <Icon name="arrowLeft" size="md" />
        </button>
      );
    }

    if (onVoiceInput) {
      return (
        <div className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
          <VoiceInputComponent
            app={app}
            onSpeechResult={onVoiceInput}
            inputRef={inputRef}
            disabled={disabled || isProcessing}
            onCommand={onVoiceCommand}
          />
        </div>
      );
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
          isOpen ? 'bg-gray-100 dark:bg-gray-700' : ''
        }`}
        title={t('chatActions.menu', 'Actions menu')}
        aria-label={t('chatActions.menu', 'Actions menu')}
      >
        <Icon name="plus-circle" size="md" />
        {hasTools && enabledCount < toolCount && (
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border border-white dark:border-gray-800"></span>
        )}
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
          {/* Quick Actions Section */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
              {t('chatActions.quickActions', 'Quick Actions')}
            </h3>
            <div className="flex flex-wrap gap-2">
              {uploadConfig?.enabled === true && (
                <button
                  type="button"
                  onClick={() => {
                    onToggleUploader?.();
                    setIsOpen(false);
                  }}
                  disabled={disabled || isProcessing}
                  title={t('chatActions.attachFile', 'Attach File')}
                  className="w-10 h-10 flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg disabled:opacity-50 transition-colors"
                >
                  <Icon name="paper-clip" size="sm" />
                </button>
              )}

              {magicPromptEnabled && !showUndoMagicPrompt && (
                <button
                  type="button"
                  onClick={() => {
                    onMagicPrompt?.();
                    setIsOpen(false);
                  }}
                  disabled={disabled || isProcessing}
                  title={t('common.magicPrompt', 'Magic Prompt')}
                  className="w-10 h-10 flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg disabled:opacity-50 transition-colors"
                >
                  {magicPromptLoading ? <MagicPromptLoader /> : <Icon name="sparkles" size="sm" />}
                </button>
              )}

              {showUndoMagicPrompt && (
                <button
                  type="button"
                  onClick={() => {
                    onUndoMagicPrompt?.();
                    setIsOpen(false);
                  }}
                  disabled={disabled || isProcessing}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-sm disabled:opacity-50 transition-colors"
                >
                  <Icon name="arrowLeft" size="sm" />
                  <span>{t('common.undo', 'Undo')}</span>
                </button>
              )}

              {onVoiceInput && (
                <div className="w-10 h-10 flex items-center justify-center bg-gray-100 dark:bg-gray-700 rounded-lg">
                  <VoiceInputComponent
                    app={app}
                    onSpeechResult={onVoiceInput}
                    inputRef={inputRef}
                    disabled={disabled || isProcessing}
                    onCommand={onVoiceCommand}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Tools Section */}
          {hasTools && (
            <div className="p-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                {t('tools.enableDisable', 'Tools')}
              </h3>

              {toolsLoading ? (
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {t('common.loading', 'Loading...')}
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Grouped tools */}
                  {grouped.map(group => {
                    const allEnabled = group.matchedTools.every(t => enabledTools.includes(t));
                    const someEnabled = group.matchedTools.some(t => enabledTools.includes(t));
                    const groupName =
                      typeof group.name === 'object'
                        ? group.name[t('common.language', 'en')] || group.name.en
                        : group.name;
                    const groupDesc =
                      typeof group.description === 'object'
                        ? group.description[t('common.language', 'en')] || group.description.en
                        : group.description;

                    return (
                      <div
                        key={group.id}
                        className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg"
                      >
                        <div className="flex-1 min-w-0 mr-3">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {groupName}
                          </div>
                          {groupDesc && (
                            <div
                              className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1"
                              title={groupDesc}
                            >
                              {groupDesc}
                            </div>
                          )}
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={allEnabled}
                            ref={el => {
                              if (el) el.indeterminate = someEnabled && !allEnabled;
                            }}
                            onChange={() => toggleTool(group.id, true, group.matchedTools)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                        </label>
                      </div>
                    );
                  })}

                  {/* Individual tools */}
                  {individual.map(toolId => {
                    const toolInfo = availableTools.find(t => t.id === toolId);
                    const toolName = toolInfo?.name || toolId;
                    const toolDescription = toolInfo?.description;
                    const isEnabled = enabledTools.includes(toolId);

                    return (
                      <div
                        key={toolId}
                        className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg"
                      >
                        <div className="flex-1 min-w-0 mr-3">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {toolName}
                          </div>
                          {toolDescription && (
                            <div
                              className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1"
                              title={toolDescription}
                            >
                              {toolDescription}
                            </div>
                          )}
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isEnabled}
                            onChange={() => toggleTool(toolId)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChatInputActionsMenu;
