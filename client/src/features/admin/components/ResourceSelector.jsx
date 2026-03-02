import { useState, useMemo } from 'react';
import Icon from '../../../shared/components/Icon';

const ResourceSelector = ({
  label,
  resources,
  selectedResources,
  onSelectionChange,
  allowWildcard = true,
  placeholder = 'Search and select...',
  emptyMessage = 'No items selected'
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const isWildcard = selectedResources.includes('*');

  // Filter available resources based on search term and exclude already selected
  const filteredResources = useMemo(() => {
    if (isWildcard) return [];

    return resources.filter(resource => {
      const name = resource.name?.en || resource.name || resource.id;
      const matchesSearch = name.toLowerCase().includes(searchTerm.toLowerCase());
      const notSelected = !selectedResources.includes(resource.id);
      return matchesSearch && notSelected;
    });
  }, [resources, searchTerm, selectedResources, isWildcard]);

  // Get display names for selected resources
  const selectedResourcesWithNames = useMemo(() => {
    if (isWildcard) return [{ id: '*', name: 'All (*)', isWildcard: true }];

    return selectedResources
      .map(id => {
        const resource = resources.find(r => r.id === id);
        return resource
          ? {
              id,
              name: resource.name?.en || resource.name || resource.id,
              isWildcard: false
            }
          : null;
      })
      .filter(Boolean);
  }, [selectedResources, resources, isWildcard]);

  const handleWildcardToggle = checked => {
    if (checked) {
      onSelectionChange(['*']);
    } else {
      onSelectionChange([]);
    }
  };

  const handleResourceAdd = resourceId => {
    if (!selectedResources.includes(resourceId)) {
      onSelectionChange([...selectedResources, resourceId]);
    }
    setSearchTerm('');
    setShowDropdown(false);
  };

  const handleResourceRemove = resourceId => {
    if (resourceId === '*') {
      onSelectionChange([]);
    } else {
      onSelectionChange(selectedResources.filter(id => id !== resourceId));
    }
  };

  const handleSearchFocus = () => {
    if (!isWildcard) {
      setShowDropdown(true);
    }
  };

  const handleSearchBlur = () => {
    // Delay hiding dropdown to allow clicking on items
    setTimeout(() => setShowDropdown(false), 200);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
        {allowWildcard && (
          <div className="flex items-center">
            <input
              type="checkbox"
              checked={isWildcard}
              onChange={e => handleWildcardToggle(e.target.checked)}
              className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">All (*)</span>
          </div>
        )}
      </div>

      {/* Selected Resources */}
      <div className="min-h-[2rem]">
        {selectedResourcesWithNames.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {selectedResourcesWithNames.map(resource => (
              <span
                key={resource.id}
                className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                  resource.isWildcard
                    ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                    : 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300'
                }`}
              >
                {resource.name}
                <button
                  onClick={() => handleResourceRemove(resource.id)}
                  className="ml-2 text-current hover:text-red-600 dark:hover:text-red-400"
                >
                  <Icon name="x" size="sm" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">{emptyMessage}</p>
        )}
      </div>

      {/* Search Input */}
      {!isWildcard && (
        <div className="relative">
          <div className="relative">
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onFocus={handleSearchFocus}
              onBlur={handleSearchBlur}
              placeholder={placeholder}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500 sm:text-sm placeholder-gray-400 dark:placeholder-gray-500"
            />
            <Icon
              name="search"
              size="sm"
              className="absolute right-3 top-2.5 text-gray-400 dark:text-gray-500"
            />
          </div>

          {/* Dropdown */}
          {showDropdown && (
            <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg max-h-60 rounded-md py-1 text-base ring-1 ring-black ring-opacity-5 dark:ring-gray-700 overflow-auto focus:outline-none sm:text-sm">
              {filteredResources.length > 0 ? (
                filteredResources.map(resource => (
                  <button
                    key={resource.id}
                    onClick={() => handleResourceAdd(resource.id)}
                    className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none"
                  >
                    <div className="flex items-center">
                      <Icon
                        name="plus"
                        size="sm"
                        className="mr-2 text-green-600 dark:text-green-400"
                      />
                      <span className="text-gray-900 dark:text-gray-100">
                        {resource.name?.en || resource.name || resource.id}
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <div className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                  {searchTerm ? 'No matching items found' : 'Start typing to search...'}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ResourceSelector;
