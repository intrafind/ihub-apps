import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import { getRecentAppIds } from '../../../utils/recentApps';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { apiClient } from '../../../api/client';

const { isFavorite } = createFavoriteItemHelpers('ihub_favorite_apps');

/**
 * Modal for selecting an app to start a chat with workflow results.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether modal is open
 * @param {Function} props.onClose - Callback to close modal
 * @param {Function} props.onSelect - Callback when an app is selected (receives app object)
 */
function AppSelectionModal({ isOpen, onClose, onSelect }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;

  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    setError(null);
    setSearchTerm('');

    apiClient
      .get('/apps')
      .then(response => {
        const enabledApps = (response.data || []).filter(a => a.enabled !== false);
        setApps(enabledApps);
      })
      .catch(err => {
        console.error('Failed to fetch apps:', err);
        setError(err.message || t('error.fetchApps', 'Failed to load apps'));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [isOpen, t]);

  const sortedAndFilteredApps = useMemo(() => {
    const recentIds = getRecentAppIds();
    const query = searchTerm.trim().toLowerCase();

    // Filter by search term
    const filtered = query
      ? apps.filter(app => {
          const name = (getLocalizedContent(app.name, currentLanguage) || app.id).toLowerCase();
          const desc = (getLocalizedContent(app.description, currentLanguage) || '').toLowerCase();
          return name.includes(query) || desc.includes(query);
        })
      : apps;

    // Sort: favorites first, then recent, then by order/alpha
    return [...filtered].sort((a, b) => {
      const aFav = isFavorite(a.id);
      const bFav = isFavorite(b.id);
      if (aFav !== bFav) return aFav ? -1 : 1;

      const aRecentIdx = recentIds.indexOf(a.id);
      const bRecentIdx = recentIds.indexOf(b.id);
      const aRecent = aRecentIdx !== -1;
      const bRecent = bRecentIdx !== -1;
      if (aRecent !== bRecent) return aRecent ? -1 : 1;
      if (aRecent && bRecent) return aRecentIdx - bRecentIdx;

      if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
      if (a.order !== undefined) return -1;
      if (b.order !== undefined) return 1;

      const aName = getLocalizedContent(a.name, currentLanguage) || a.id;
      const bName = getLocalizedContent(b.name, currentLanguage) || b.id;
      return aName.localeCompare(bName);
    });
  }, [apps, searchTerm, currentLanguage]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50 transition-opacity" onClick={onClose} />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-900 rounded-full flex items-center justify-center">
                <Icon
                  name="chat-bubble-left-right"
                  className="w-5 h-5 text-indigo-600 dark:text-indigo-400"
                />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {t('workflows.chatWithResults.selectApp', 'Select an App')}
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'workflows.chatWithResults.selectAppDescription',
                    'Choose an app to continue chatting with the workflow output'
                  )}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition-colors"
            >
              <Icon name="x" className="w-6 h-6" />
            </button>
          </div>

          {/* Search */}
          {!loading && !error && apps.length > 0 && (
            <div className="px-4 pt-3">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Icon name="search" className="h-4 w-4 text-gray-400" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-9 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder={t('workflows.chatWithResults.searchApps', 'Search apps...')}
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
          )}

          {/* Body */}
          <div className="p-4 overflow-y-auto flex-1">
            {loading && (
              <div className="flex items-center justify-center py-8">
                <LoadingSpinner message={t('common.loading', 'Loading...')} />
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-100 border border-red-300 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            {!loading && !error && apps.length === 0 && (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                {t('workflows.chatWithResults.noApps', 'No apps available')}
              </div>
            )}

            {!loading && !error && apps.length > 0 && sortedAndFilteredApps.length === 0 && (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                {t('workflows.chatWithResults.noMatchingApps', 'No apps match your search')}
              </div>
            )}

            {!loading && !error && sortedAndFilteredApps.length > 0 && (
              <div className="grid gap-2">
                {sortedAndFilteredApps.map(app => {
                  const name = getLocalizedContent(app.name, currentLanguage) || app.id;
                  const description = getLocalizedContent(app.description, currentLanguage) || '';
                  const favorite = isFavorite(app.id);

                  return (
                    <button
                      key={app.id}
                      onClick={() => onSelect(app)}
                      className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left w-full"
                    >
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: app.color || '#4F46E5' }}
                      >
                        <Icon
                          name={app.icon || 'chat-bubble-left'}
                          className="w-5 h-5 text-white"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-gray-900 dark:text-white truncate">
                            {name}
                          </span>
                          {favorite && (
                            <Icon
                              name="star-solid"
                              className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0"
                            />
                          )}
                        </div>
                        {description && (
                          <div className="text-sm text-gray-500 dark:text-gray-400 truncate">
                            {description}
                          </div>
                        )}
                      </div>
                      <Icon name="chevron-right" className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end p-4 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg font-medium transition-colors"
            >
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AppSelectionModal;
