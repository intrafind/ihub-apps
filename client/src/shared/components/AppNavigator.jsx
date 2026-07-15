import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { fetchApps } from '../../api';
import { useUIConfig } from '../contexts/UIConfigContext';
import { useAppNavigator } from '../../hooks/useAppNavigator';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import {
  filterAppsForNavigator,
  groupAppsByCategory,
  OTHER_CATEGORY_ID
} from '../utils/appNavigatorGroups';
import Icon from './Icon';
import AppNavigatorCategory from './AppNavigatorCategory';

function AppNavigator() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const location = useLocation();
  const { uiConfig } = useUIConfig();
  // Registers the global Ctrl/Cmd+B shortcut (FR-10) for as long as this component is mounted.
  const { isOpen, close, toggleCategory, isCategoryCollapsed } = useAppNavigator();

  const [apps, setApps] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const listRef = useRef(null);

  const appNavigatorConfig = uiConfig?.appNavigator || { enabled: true, categoryOrder: [] };
  const categoryMeta = useMemo(
    () => uiConfig?.appsList?.categories?.list || [],
    [uiConfig?.appsList?.categories?.list]
  );

  // Closes the sidebar and clears the search box so the next open starts fresh.
  const handleClose = useCallback(() => {
    close();
    setSearchTerm('');
  }, [close]);

  useEffect(() => {
    if (isOpen && apps.length === 0) {
      fetchApps()
        .then(setApps)
        .catch(err => console.error('Failed to load apps for navigator', err));
    }
  }, [isOpen, apps.length]);

  // FR-8: close on route change (e.g. after clicking an app).
  useEffect(() => {
    handleClose();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [location.pathname]);

  // FR-8: close on Escape from anywhere in the sidebar, including the search input.
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = e => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  const filteredApps = useMemo(
    () => filterAppsForNavigator(apps, searchTerm, currentLanguage),
    [apps, searchTerm, currentLanguage]
  );

  const groups = useMemo(
    () =>
      groupAppsByCategory({
        apps: filteredApps,
        categoryOrder: appNavigatorConfig.categoryOrder || [],
        categoryMeta
      }),
    [filteredApps, appNavigatorConfig.categoryOrder, categoryMeta]
  );

  // FR-9: Up/Down arrow key navigation between app items while the sidebar is open.
  useKeyboardNavigation(listRef, {
    isActive: isOpen,
    orientation: 'vertical',
    onClose: handleClose
  });

  if (appNavigatorConfig.enabled === false) return null;

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/30 z-40" onClick={handleClose} aria-hidden="true" />
      )}
      <aside
        className={`fixed top-0 left-0 h-full w-[300px] max-w-[85vw] bg-white dark:bg-gray-900 shadow-xl z-50 flex flex-col transition-transform duration-200 ease-out ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={t('appNavigator.title', 'Apps')}
        aria-hidden={!isOpen}
      >
        <div className="flex items-center justify-between px-4 h-16 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">
            {t('appNavigator.title', 'Apps')}
          </h2>
          <button
            onClick={handleClose}
            className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x" size="md" />
          </button>
        </div>

        <div className="px-3 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Icon name="search" className="h-4 w-4 text-gray-400" />
            </div>
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={t('appNavigator.searchPlaceholder', 'Search apps...')}
              aria-label={t('appNavigator.searchPlaceholder', 'Search apps...')}
              autoComplete="off"
              className="block w-full pl-9 pr-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-md text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
        </div>

        <div ref={listRef} role="menu" className="flex-1 overflow-y-auto px-2 py-2">
          {groups.length === 0 && (
            <p className="text-center text-sm text-gray-500 dark:text-gray-400 py-8">
              {t('appNavigator.noResults', 'No apps found')}
            </p>
          )}
          {groups.map(group => (
            <AppNavigatorCategory
              key={group.id}
              group={group}
              fallbackLabel={
                group.id === OTHER_CATEGORY_ID ? t('appNavigator.otherCategory', 'Other') : group.id
              }
              isCollapsed={isCategoryCollapsed(group.id)}
              onToggle={() => toggleCategory(group.id)}
              currentLanguage={currentLanguage}
              onNavigate={handleClose}
            />
          ))}
        </div>
      </aside>
    </>
  );
}

export default AppNavigator;
