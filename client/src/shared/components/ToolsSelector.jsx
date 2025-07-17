import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';

const ToolsSelector = ({ selectedTools = [], onToolsChange }) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  // Available tools list
  const availableTools = [
    'researchPlanner',
    'deepResearch',
    'queryRewriter',
    'evaluator',
    'braveSearch',
    'enhancedWebSearch',
    'tavilySearch',
    'webContentExtractor',
    'answerReducer',
    'finalizer',
    'playwrightScreenshot',
    'seleniumScreenshot'
  ];

  // Filter tools based on search term and exclude already selected
  const filteredTools = availableTools.filter(tool => {
    const matchesSearch = tool.toLowerCase().includes(searchTerm.toLowerCase());
    const notSelected = !selectedTools.includes(tool);
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
    if (!selectedTools.includes(tool)) {
      onToolsChange([...selectedTools, tool]);
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
          {selectedTools.map(tool => (
            <span
              key={tool}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium bg-indigo-100 text-indigo-800"
            >
              {tool}
              <button
                onClick={() => handleRemoveTool(tool)}
                className="ml-1 flex-shrink-0 text-indigo-600 hover:text-indigo-800"
                aria-label={`Remove ${tool}`}
              >
                <Icon name="x" className="w-3 h-3" />
              </button>
            </span>
          ))}
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
            {filteredTools.length > 0 ? (
              filteredTools.map(tool => (
                <button
                  key={tool}
                  onClick={() => handleAddTool(tool)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none"
                >
                  {tool}
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-gray-500">
                {searchTerm
                  ? t('admin.apps.edit.noToolsFound', 'No tools found matching "{{searchTerm}}"', {
                    searchTerm
                  })
                  : t('admin.apps.edit.allToolsSelected', 'All tools are already selected')}
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
