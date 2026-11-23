// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { CHECKBOX_CLASS } from './formStyles';

/**
 * The text a resource is shown and searched by. A name is either a plain text
 * (models, groups) or one text per language (apps, prompts); an app written in
 * one language has only that language, so `name.en` may not exist.
 *
 * @param {{ id: string, name?: string | Record<string, string> }} resource
 * @param {string} [language] - The base language of the UI, such as `de`.
 * @returns {string} The name in that language, else in another language the
 *   resource has, else the ID.
 */
function resourceLabel(resource, language) {
  const name = getLocalizedContent(resource.name, language);
  return typeof name === 'string' && name.trim() !== '' ? name : String(resource.id);
}

function ResourceSelector({
  label,
  resources,
  selectedResources,
  onSelectionChange,
  allowWildcard = true,
  placeholder,
  emptyMessage
}) {
  const { t, i18n } = useTranslation();
  // Localized names are stored under base languages, so `de-DE` reads `de`.
  const uiLanguage = i18n.language?.split('-')[0] || undefined;
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  // The field label names the search input; the "All (*)" checkbox is named
  // by its own label text plus the field label, so several selectors on one
  // page stay distinguishable for screen readers.
  const searchId = useId();

  const isWildcard = selectedResources.includes('*');

  // Every resource with the one text it is shown and searched by.
  const namedResources = useMemo(
    () =>
      resources.map(resource => ({ id: resource.id, name: resourceLabel(resource, uiLanguage) })),
    [resources, uiLanguage]
  );

  // Filter available resources based on search term and exclude already selected
  const filteredResources = useMemo(() => {
    if (isWildcard) return [];

    const term = searchTerm.toLowerCase();
    return namedResources.filter(
      resource =>
        resource.name.toLowerCase().includes(term) && !selectedResources.includes(resource.id)
    );
  }, [namedResources, searchTerm, selectedResources, isWildcard]);

  // Get display names for selected resources
  const selectedResourcesWithNames = useMemo(() => {
    if (isWildcard) return [{ id: '*', name: t('admin.resourceSelector.all'), isWildcard: true }];

    return selectedResources
      .map(id => {
        const resource = namedResources.find(r => r.id === id);
        return resource ? { id, name: resource.name, isWildcard: false } : null;
      })
      .filter(Boolean);
  }, [selectedResources, namedResources, isWildcard, t]);

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
        <label
          htmlFor={searchId}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {label}
        </label>
        {allowWildcard && (
          <label className="flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={isWildcard}
              onChange={e => handleWildcardToggle(e.target.checked)}
              aria-label={
                typeof label === 'string' && label
                  ? t('admin.groups.form.allWildcardFor', '{{label}}: All (*)', { label })
                  : undefined
              }
              className={`${CHECKBOX_CLASS} mr-2`}
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              {t('admin.groups.form.allWildcard', 'All (*)')}
            </span>
          </label>
        )}
      </div>

      {/* Selected Resources */}
      <div className="min-h-8">
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
                  type="button"
                  onClick={() => handleResourceRemove(resource.id)}
                  className="ml-2 text-current hover:text-red-600 dark:hover:text-red-400"
                >
                  <Icon name="x" size="sm" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            {emptyMessage ?? t('admin.resourceSelector.noneSelected')}
          </p>
        )}
      </div>

      {/* Search Input */}
      {!isWildcard && (
        <div className="relative">
          <div className="relative">
            <input
              id={searchId}
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onFocus={handleSearchFocus}
              onBlur={handleSearchBlur}
              placeholder={placeholder ?? t('admin.resourceSelector.placeholder')}
              className="w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md shadow-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-admin-accent focus:border-admin-accent sm:text-sm placeholder-gray-500 dark:placeholder-gray-300"
            />
            <Icon
              name="search"
              size="sm"
              className="absolute right-3 top-2.5 text-gray-500 dark:text-gray-400"
            />
          </div>

          {/* Dropdown */}
          {showDropdown && (
            <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg max-h-60 rounded-md py-1 text-base ring-1 ring-black/5 dark:ring-gray-700/5 overflow-auto focus:outline-hidden sm:text-sm">
              {filteredResources.length > 0 ? (
                filteredResources.map(resource => (
                  <button
                    type="button"
                    key={resource.id}
                    onClick={() => handleResourceAdd(resource.id)}
                    className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-hidden"
                  >
                    <div className="flex items-center">
                      <Icon
                        name="plus"
                        size="sm"
                        className="mr-2 text-green-700 dark:text-green-400"
                      />
                      <span className="text-gray-900 dark:text-gray-100">{resource.name}</span>
                    </div>
                  </button>
                ))
              ) : (
                <div className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                  {searchTerm
                    ? t('admin.resourceSelector.noMatches')
                    : t('admin.resourceSelector.startTyping')}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ResourceSelector;
