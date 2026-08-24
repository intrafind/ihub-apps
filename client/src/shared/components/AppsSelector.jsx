import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { fetchAdminApps } from '../../api/endpoints/admin';
import { getLocalizedContent } from '../../utils/localizeContent';

/**
 * AppsSelector - Multi-select component for choosing apps another app may
 * invoke as tools (app-as-tool / concierge pattern). Mirrors WorkflowsSelector
 * but reads from the admin apps endpoint and stores selections as app id
 * strings in app.apps.
 *
 * @param {Object} props
 * @param {string[]} props.selectedApps - Array of selected app id strings
 * @param {Function} props.onAppsChange - Callback receiving updated array of app id strings
 * @param {string} [props.excludeAppId] - App id to hide from the picker (the app being edited)
 */
function AppsSelector({ selectedApps = [], onAppsChange, excludeAppId }) {
  const { t, i18n } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [availableApps, setAvailableApps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  useEffect(() => {
    const loadApps = async () => {
      try {
        setIsLoading(true);
        const apps = await fetchAdminApps();
        // Only enabled chat apps can answer a delegated message — redirect and
        // iframe apps have no chat pipeline to run.
        const callable = (Array.isArray(apps) ? apps : []).filter(
          a => a.enabled !== false && (!a.type || a.type === 'chat')
        );
        setAvailableApps(callable);
      } catch (error) {
        console.error('Failed to fetch apps:', error);
        setAvailableApps([]);
      } finally {
        setIsLoading(false);
      }
    };
    loadApps();
  }, []);

  const localize = value => getLocalizedContent(value, i18n.language) || '';

  const filteredApps = availableApps.filter(app => {
    if (excludeAppId && app.id === excludeAppId) return false;
    const name = localize(app.name) || app.id;
    const description = localize(app.description);
    const searchableText = `${app.id} ${name} ${description}`.toLowerCase();
    const matchesSearch = searchableText.includes(searchTerm.toLowerCase());
    const notSelected = !selectedApps.includes(app.id);
    return matchesSearch && notSelected;
  });

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

  useEffect(() => {
    if (isDropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isDropdownOpen]);

  const handleAddApp = app => {
    const id = typeof app === 'string' ? app : app.id;
    if (!selectedApps.includes(id)) {
      onAppsChange([...selectedApps, id]);
    }
    setSearchTerm('');
    setIsDropdownOpen(false);
  };

  const handleRemoveApp = idToRemove => {
    onAppsChange(selectedApps.filter(id => id !== idToRemove));
  };

  const handleSearchChange = e => {
    setSearchTerm(e.target.value);
    setIsDropdownOpen(true);
  };

  const handleSearchKeyDown = e => {
    if (e.key === 'Enter' && filteredApps.length > 0) {
      e.preventDefault();
      handleAddApp(filteredApps[0]);
    } else if (e.key === 'Escape') {
      setIsDropdownOpen(false);
      setSearchTerm('');
    }
  };

  return (
    <div className="space-y-3">
      {selectedApps.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedApps.map(id => {
            const app = availableApps.find(a => a.id === id);
            const displayName = app ? localize(app.name) || app.id : id;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300"
              >
                <Icon name="chat" className="w-3 h-3" />
                {displayName}
                <button
                  type="button"
                  onClick={() => handleRemoveApp(id)}
                  className="ml-1 flex-shrink-0 text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300"
                  aria-label={t('admin.apps.edit.removeAppTool', 'Remove {{name}}', {
                    name: displayName
                  })}
                >
                  <Icon name="x" className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="relative" ref={dropdownRef}>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Icon name="search" className="h-5 w-5 text-gray-400 dark:text-gray-500" />
          </div>
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('admin.apps.edit.searchApps', 'Search apps to add...')}
            value={searchTerm}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setIsDropdownOpen(true)}
            className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            autoComplete="off"
          />
        </div>

        {isDropdownOpen && (
          <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-60 overflow-auto">
            {isLoading ? (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {t('common.loading', 'Loading...')}
              </div>
            ) : filteredApps.length > 0 ? (
              filteredApps.map(app => {
                const name = localize(app.name) || app.id;
                const description = localize(app.description);
                return (
                  <button
                    type="button"
                    key={app.id}
                    onClick={() => handleAddApp(app)}
                    className="w-full text-left px-3 py-3 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                  >
                    <div className="font-medium text-gray-900 dark:text-gray-100">{name}</div>
                    {description && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                        {description}
                      </div>
                    )}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {searchTerm
                  ? t('admin.apps.edit.appsAsToolsNoResults', 'No apps match your search')
                  : t('admin.apps.edit.appsAsToolsNoApps', 'No apps available')}
              </div>
            )}
          </div>
        )}
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t(
          'admin.apps.edit.appsAsToolsHelper',
          'Each selected app becomes a tool (app__<id>) the model can call. Users only reach apps they have permission for, and a called app cannot call further apps.'
        )}
      </p>
    </div>
  );
}

export default AppsSelector;
