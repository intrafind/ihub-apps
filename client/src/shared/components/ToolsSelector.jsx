import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { fetchTools } from '../../api/api';
import { getLocalizedContent } from '../../utils/localizeContent';

const ToolsSelector = ({ selectedTools = [], onToolsChange }) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [availableTools, setAvailableTools] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  // Fetch tools from API
  useEffect(() => {
    const loadTools = async () => {
      try {
        setIsLoading(true);
        const tools = await fetchTools();
        setAvailableTools(tools || []);
      } catch (error) {
        console.error('Failed to fetch tools:', error);
        setAvailableTools([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadTools();
  }, []);

  // Filter tools based on search term and exclude already selected
  const filteredTools = availableTools.filter(tool => {
    const toolName = (getLocalizedContent(tool.name, currentLanguage) || tool.id).toLowerCase();
    const toolDescription = (
      getLocalizedContent(tool.description, currentLanguage) || ''
    ).toLowerCase();
    const searchableText = `${toolName} ${toolDescription}`;
    const matchesSearch = searchableText.includes(searchTerm.toLowerCase());
    const notSelected = !selectedTools.includes(tool.id);
    return matchesSearch && notSelected;
  });

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isDropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isDropdownOpen]);

  const handleAddTool = tool => {
    const toolId = typeof tool === 'string' ? tool : tool.id;
    if (!selectedTools.includes(toolId)) {
      onToolsChange([...selectedTools, toolId]);
    }
    setSearchTerm('');
    setIsDropdownOpen(false);
  };

  const handleRemoveTool = toolToRemove => {
    onToolsChange(selectedTools.filter(tool => tool !== toolToRemove));
  };

  const handleSearchChange = e => {
    setSearchTerm(e.target.value);
    setIsDropdownOpen(true);
  };

  const handleSearchKeyDown = e => {
    if (e.key === 'Enter' && filteredTools.length > 0) {
      handleAddTool(filteredTools[0]);
    } else if (e.key === 'Escape') {
      setIsDropdownOpen(false);
      setSearchTerm('');
    }
  };

  return (
    <div className="space-y-3">
      {/* Selected Tools */}
      {selectedTools.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedTools.map(toolId => {
            const toolInfo = availableTools.find(t => t.id === toolId);
            const displayName = toolInfo
              ? getLocalizedContent(toolInfo.name, currentLanguage)
              : toolId;
            return (
              <span
                key={toolId}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium bg-indigo-100 text-indigo-800"
              >
                {displayName}
                <button
                  onClick={() => handleRemoveTool(toolId)}
                  className="ml-1 flex-shrink-0 text-indigo-600 hover:text-indigo-800"
                  aria-label={`Remove ${displayName}`}
                >
                  <Icon name="x" className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search and Add Tools */}
      <div className="relative" ref={dropdownRef}>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Icon name="search" className="h-5 w-5 text-gray-400" />
          </div>
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('admin.apps.edit.searchTools', 'Search tools to add...')}
            value={searchTerm}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setIsDropdownOpen(true)}
            className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            autoComplete="off"
          />
        </div>

        {/* Dropdown */}
        {isDropdownOpen && (
          <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
            {isLoading ? (
              <div className="px-3 py-2 text-sm text-gray-500">
                {t('common.loading', 'Loading...')}
              </div>
            ) : filteredTools.length > 0 ? (
              filteredTools.map(tool => (
                <button
                  key={tool.id}
                  onClick={() => handleAddTool(tool)}
                  className="w-full text-left px-3 py-3 text-sm text-gray-700 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none border-b border-gray-100 last:border-b-0"
                >
                  <div className="font-medium text-gray-900">
                    {getLocalizedContent(tool.name, currentLanguage)}
                  </div>
                  {tool.description && (
                    <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                      {getLocalizedContent(tool.description, currentLanguage)}
                    </div>
                  )}
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-gray-500">
                {searchTerm
                  ? t('admin.apps.wizard.tools.noResults', 'No tools match your search')
                  : t('admin.apps.wizard.tools.noTools', 'No tools available')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Helper text */}
      <p className="text-sm text-gray-500">
        {t(
          'admin.apps.edit.toolsHelper',
          'Search and select tools to add to this app. Click on selected tools to remove them.'
        )}
      </p>
    </div>
  );
};

export default ToolsSelector;
