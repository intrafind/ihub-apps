import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';

const SearchableAppsSelector = ({ apps, value, onChange, placeholder, currentLanguage }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredApps = apps.filter(app => {
    const appName = getLocalizedContent(app.name, currentLanguage);
    return (
      appName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      app.id.toLowerCase().includes(searchTerm.toLowerCase())
    );
  });

  const selectedApp = apps.find(app => app.id === value);

  const handleSelect = app => {
    onChange(app.id);
    setIsOpen(false);
    setSearchTerm('');
  };

  const handleClear = () => {
    onChange('');
    setSearchTerm('');
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="relative w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm pl-3 pr-10 py-2 text-left cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
        >
          <span className="block truncate">
            {selectedApp ? (
              <span className="flex items-center">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {getLocalizedContent(selectedApp.name, currentLanguage)}
                </span>
                <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
                  ({selectedApp.id})
                </span>
              </span>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">{placeholder}</span>
            )}
          </span>
          <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <Icon name="chevron-down" className="h-5 w-5 text-gray-400 dark:text-gray-500" />
          </span>
        </button>

        {selectedApp && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute inset-y-0 right-8 flex items-center pr-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        )}
      </div>

      {isOpen && (
        <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg max-h-60 rounded-md py-1 text-base ring-1 ring-black ring-opacity-5 dark:ring-gray-700 overflow-auto focus:outline-none sm:text-sm">
          {/* Search input */}
          <div className="sticky top-0 bg-white dark:bg-gray-800 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Icon name="search" className="h-4 w-4 text-gray-400 dark:text-gray-500" />
              </div>
              <input
                ref={inputRef}
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 placeholder-gray-400 dark:placeholder-gray-500"
                placeholder={t('admin.prompts.edit.searchApps', 'Search apps...')}
                autoComplete="off"
              />
            </div>
          </div>

          {/* Clear selection option */}
          <div
            className="cursor-pointer select-none relative py-2 pl-3 pr-9 text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700"
            onClick={handleClear}
          >
            <div className="flex items-center">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t('admin.prompts.edit.noApp', 'No linked app')}
              </span>
            </div>
          </div>

          {/* App options */}
          {filteredApps.length > 0 ? (
            filteredApps.map(app => (
              <div
                key={app.id}
                className={`cursor-pointer select-none relative py-2 pl-3 pr-9 hover:bg-gray-50 dark:hover:bg-gray-700 ${
                  app.id === value
                    ? 'bg-indigo-50 dark:bg-indigo-900/50 text-indigo-900 dark:text-indigo-100'
                    : 'text-gray-900 dark:text-gray-100'
                }`}
                onClick={() => handleSelect(app)}
              >
                <div className="flex items-center">
                  <div
                    className="flex-shrink-0 h-6 w-6 rounded-md flex items-center justify-center text-white text-xs font-bold mr-3"
                    style={{ backgroundColor: app.color || '#6B7280' }}
                  >
                    <Icon name={app.icon || 'chat-bubbles'} className="h-3 w-3" />
                  </div>
                  <span className="block truncate text-sm font-medium">
                    {getLocalizedContent(app.name, currentLanguage)}
                  </span>
                  <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">({app.id})</span>
                </div>
                {app.id === value && (
                  <span className="absolute inset-y-0 right-0 flex items-center pr-4 text-indigo-600 dark:text-indigo-400">
                    <Icon name="check" className="h-4 w-4" />
                  </span>
                )}
              </div>
            ))
          ) : (
            <div className="py-2 pl-3 pr-9 text-gray-500 dark:text-gray-400 text-sm">
              {t('admin.prompts.edit.noAppsFound', 'No apps found')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchableAppsSelector;
