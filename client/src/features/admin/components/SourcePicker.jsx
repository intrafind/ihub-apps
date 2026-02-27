import { useState, useEffect } from 'react';
import { MagnifyingGlassIcon, XMarkIcon, CheckIcon } from '@heroicons/react/24/outline';
import { adminApi } from '../../../api/adminApi';

/**
 * Source Picker Component
 *
 * Reusable component for selecting admin-configured sources in app configurations.
 * Provides search, filtering, and multi-selection capabilities.
 *
 * Features:
 * - Search sources by name or description
 * - Filter by source type (filesystem, url, ifinder)
 * - Multi-select with visual feedback
 * - Real-time loading of available sources
 * - Disabled state for sources not enabled
 *
 * @param {object} props - Component properties
 * @param {Array} props.value - Currently selected source IDs
 * @param {Function} props.onChange - Callback when selection changes
 * @param {boolean} props.allowMultiple - Allow multiple selections (default: true)
 * @param {string} props.className - Additional CSS classes
 * @param {boolean} props.disabled - Disable the picker
 */
function SourcePicker({
  value = [],
  onChange,
  allowMultiple = true,
  className = '',
  disabled = false
}) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set(value || []));

  // Load available admin sources on mount
  useEffect(() => {
    loadAdminSources();
  }, []);

  // Update selected IDs when value prop changes
  useEffect(() => {
    setSelectedIds(new Set(value || []));
  }, [value]);

  /**
   * Load admin sources from API
   */
  const loadAdminSources = async () => {
    try {
      setLoading(true);
      setError(null);
      setFeatureDisabled(false);

      const sources = await adminApi.getSources();

      // Only show enabled sources for selection
      const enabledSources = sources.filter(source => source.enabled !== false);
      setSources(enabledSources);

      console.log(`Loaded ${enabledSources.length} enabled sources for picker`);
    } catch (err) {
      console.error('Failed to load sources:', err);

      // Check if this is a feature disabled error (403 with FEATURE_DISABLED code)
      if (err.response?.status === 403 && err.response?.data?.code === 'FEATURE_DISABLED') {
        console.log('Sources feature is disabled');
        setFeatureDisabled(true);
        setError(null); // Don't show error, just hide the component
      } else {
        setError('Failed to load available sources. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle source selection/deselection
   *
   * @param {string} sourceId - Source ID to toggle
   */
  const handleSourceToggle = sourceId => {
    if (disabled) return;

    const newSelected = new Set(selectedIds);

    if (newSelected.has(sourceId)) {
      // Deselect
      newSelected.delete(sourceId);
    } else {
      // Select
      if (!allowMultiple) {
        // Single selection mode - clear previous selections
        newSelected.clear();
      }
      newSelected.add(sourceId);
    }

    setSelectedIds(newSelected);

    // Notify parent component
    const selectedArray = Array.from(newSelected);
    onChange?.(selectedArray);
  };

  /**
   * Get localized source name
   *
   * @param {object} source - Source object
   * @returns {string} Localized name
   */
  const getSourceName = source => {
    if (typeof source.name === 'string') {
      return source.name;
    }
    if (typeof source.name === 'object') {
      return source.name.en || source.name.de || Object.values(source.name)[0] || source.id;
    }
    return source.id;
  };

  /**
   * Get localized source description
   *
   * @param {object} source - Source object
   * @returns {string} Localized description
   */
  const getSourceDescription = source => {
    if (typeof source.description === 'string') {
      return source.description;
    }
    if (typeof source.description === 'object') {
      return (
        source.description.en || source.description.de || Object.values(source.description)[0] || ''
      );
    }
    return '';
  };

  /**
   * Filter sources based on search and type filter
   *
   * @returns {Array} Filtered sources
   */
  const getFilteredSources = () => {
    return sources.filter(source => {
      // Type filter
      if (typeFilter !== 'all' && source.type !== typeFilter) {
        return false;
      }

      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const name = getSourceName(source).toLowerCase();
        const description = getSourceDescription(source).toLowerCase();
        const id = source.id.toLowerCase();

        return name.includes(query) || description.includes(query) || id.includes(query);
      }

      return true;
    });
  };

  /**
   * Get source type icon
   *
   * @param {string} type - Source type
   * @returns {string} Icon class or emoji
   */
  const getTypeIcon = type => {
    switch (type) {
      case 'filesystem':
        return '📁';
      case 'url':
        return '🌐';
      case 'ifinder':
        return '🔍';
      default:
        return '📄';
    }
  };

  /**
   * Clear all selections
   */
  const handleClearAll = () => {
    if (disabled) return;
    setSelectedIds(new Set());
    onChange?.([]);
  };

  const filteredSources = getFilteredSources();

  // If feature is disabled, show nothing (section should be hidden by parent)
  if (featureDisabled) {
    return null;
  }

  return (
    <div className={`source-picker ${className}`}>
      {/* Header with search and filters */}
      <div className="mb-4">
        {/* Search input */}
        <div className="relative mb-3">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <MagnifyingGlassIcon className="h-5 w-5 text-gray-400 dark:text-gray-500" />
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search sources by name, description, or ID..."
            disabled={disabled || loading}
            className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md leading-5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 sm:text-sm disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500"
          />
        </div>

        {/* Type filter and selection info */}
        <div className="flex justify-between items-center">
          <div className="flex items-center space-x-3">
            {/* Type filter */}
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              disabled={disabled || loading}
              className="block w-32 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500"
            >
              <option value="all">All Types</option>
              <option value="filesystem">📁 Files</option>
              <option value="url">🌐 URLs</option>
              <option value="ifinder">🔍 iFinder</option>
            </select>

            {/* Selection count */}
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {selectedIds.size > 0 && `${selectedIds.size} selected`}
            </span>
          </div>

          {/* Clear button */}
          {selectedIds.size > 0 && (
            <button
              onClick={handleClearAll}
              disabled={disabled}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:text-gray-400"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 dark:border-blue-400"></div>
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading sources...</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4 mb-4">
          <div className="flex">
            <XMarkIcon className="h-5 w-5 text-red-400 dark:text-red-500" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
                Error Loading Sources
              </h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-400">{error}</p>
              <button
                onClick={loadAdminSources}
                className="mt-2 text-sm text-red-600 dark:text-red-400 hover:text-red-500 dark:hover:text-red-300 underline"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sources list */}
      {!loading && !error && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-md max-h-64 overflow-y-auto">
          {filteredSources.length === 0 ? (
            <div className="p-4 text-center text-gray-500 dark:text-gray-400">
              {searchQuery || typeFilter !== 'all' ? (
                <div>
                  <p>No sources match your filters.</p>
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setTypeFilter('all');
                    }}
                    className="mt-1 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300"
                  >
                    Clear filters
                  </button>
                </div>
              ) : (
                <div>
                  <p>No sources available.</p>
                  <p className="text-sm mt-1">Create sources in the admin interface first.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              {filteredSources.map(source => {
                const isSelected = selectedIds.has(source.id);
                const sourceName = getSourceName(source);
                const sourceDescription = getSourceDescription(source);

                return (
                  <div
                    key={source.id}
                    onClick={() => handleSourceToggle(source.id)}
                    className={`flex items-center p-3 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/40'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                    } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    {/* Selection indicator */}
                    <div
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center mr-3 ${
                        isSelected
                          ? 'bg-blue-600 border-blue-600'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}
                    >
                      {isSelected && <CheckIcon className="w-3 h-3 text-white" />}
                    </div>

                    {/* Source info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center">
                        <span className="text-lg mr-2">{getTypeIcon(source.type)}</span>
                        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {sourceName}
                        </h4>
                        <span className="ml-2 px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded">
                          {source.id}
                        </span>
                      </div>
                      {sourceDescription && (
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 truncate">
                          {sourceDescription}
                        </p>
                      )}
                      <div className="mt-1 flex items-center space-x-2 text-xs text-gray-400 dark:text-gray-500">
                        <span>Type: {source.type}</span>
                        {source.config?.path && <span>• Path: {source.config.path}</span>}
                        {source.config?.url && (
                          <span>• URL: {new URL(source.config.url).hostname}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Selected sources summary */}
      {selectedIds.size > 0 && (
        <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Selected Sources ({selectedIds.size})
          </h4>
          <div className="flex flex-wrap gap-2">
            {Array.from(selectedIds).map(sourceId => {
              const source = sources.find(s => s.id === sourceId);
              if (!source) return null;

              return (
                <span
                  key={sourceId}
                  className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300"
                >
                  {getTypeIcon(source.type)} {getSourceName(source)}
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      handleSourceToggle(sourceId);
                    }}
                    disabled={disabled}
                    className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full text-blue-400 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800 hover:text-blue-600 dark:hover:text-blue-200 focus:outline-none disabled:cursor-not-allowed"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default SourcePicker;
