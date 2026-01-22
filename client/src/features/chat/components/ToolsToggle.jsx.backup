import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchToolsBasic } from '../../../api/api';

/**
 * ToolsToggle component - displays near chat input to toggle tools on/off
 * Supports tool grouping (e.g., all web search tools under one toggle)
 */
const ToolsToggle = ({ app, enabledTools, onEnabledToolsChange }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [availableTools, setAvailableTools] = useState([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const dropdownRef = useRef(null);

  // Tool grouping configuration - group similar tools together
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

  if (!app?.tools || app.tools.length === 0) {
    return null;
  }

  // Get grouped and individual tools
  const getToolsStructure = () => {
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
      // Toggle all tools in the group
      const allEnabled = groupTools.every(t => enabledTools.includes(t));
      let newEnabledTools;

      if (allEnabled) {
        // Disable all tools in the group
        newEnabledTools = enabledTools.filter(t => !groupTools.includes(t));
      } else {
        // Enable all tools in the group
        const toAdd = groupTools.filter(t => !enabledTools.includes(t));
        newEnabledTools = [...enabledTools, ...toAdd];
      }

      onEnabledToolsChange?.(newEnabledTools);
    } else {
      // Toggle individual tool
      const isEnabled = enabledTools.includes(toolId);
      const newEnabledTools = isEnabled
        ? enabledTools.filter(t => t !== toolId)
        : [...enabledTools, toolId];
      onEnabledToolsChange?.(newEnabledTools);
    }
  };

  const isToolEnabled = (toolId, isGroup = false, groupTools = []) => {
    if (isGroup) {
      return groupTools.some(t => enabledTools.includes(t));
    }
    return enabledTools.includes(toolId);
  };

  const toolCount = app.tools.length;
  const enabledCount = app.tools.filter(t => enabledTools.includes(t)).length;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`image-upload-button h-fit relative ${isOpen ? 'active' : ''}`}
        title={t('tools.toggle', 'Toggle tools')}
        aria-label={t('tools.toggle', 'Toggle tools')}
      >
        <Icon name="adjustments" size="md" />
        {enabledCount < toolCount && (
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border border-white"></span>
        )}
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-2 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('tools.title', 'Tools')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t('tools.subtitle', 'Enable or disable tools for this chat')}
            </p>
          </div>

          {toolsLoading ? (
            <div className="p-3 text-sm text-gray-500 dark:text-gray-400">
              {t('common.loading', 'Loading...')}
            </div>
          ) : (
            <div className="p-2 max-h-64 overflow-y-auto">
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
                    className="flex items-start p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer"
                    onClick={() => toggleTool(group.id, true, group.matchedTools)}
                  >
                    <input
                      type="checkbox"
                      checked={allEnabled}
                      ref={el => {
                        if (el) el.indeterminate = someEnabled && !allEnabled;
                      }}
                      onChange={() => {}}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 mt-0.5 mr-3 flex-shrink-0 pointer-events-none"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {groupName}
                      </div>
                      {groupDesc && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {groupDesc}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Individual tools */}
              {individual.map(toolId => {
                const toolInfo = availableTools.find(t => t.id === toolId);
                const toolName = toolInfo?.name || toolId;
                const toolDescription = toolInfo?.description;
                const isEnabled = isToolEnabled(toolId);

                return (
                  <div
                    key={toolId}
                    className="flex items-start p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer"
                    onClick={() => toggleTool(toolId)}
                  >
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={() => {}}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 mt-0.5 mr-3 flex-shrink-0 pointer-events-none"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {toolName}
                      </div>
                      {toolDescription && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {toolDescription}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolsToggle;
