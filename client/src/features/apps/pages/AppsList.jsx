import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { fetchApps } from '../../../api/api';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import { getRecentAppIds } from '../../../utils/recentApps';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { useAuth } from '../../../shared/contexts/AuthContext';
import Icon from '../../../shared/components/Icon';

// Instead of fixed values, we'll calculate based on viewport
const AppsList = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { resetHeaderColor, uiConfig } = useUIConfig();
  const { user, isAuthenticated } = useAuth();

  // Create favorite apps helpers
  const { getFavorites: getFavoriteApps, toggleFavorite: toggleFavoriteApp } =
    createFavoriteItemHelpers('ihub_favorite_apps');

  // Get search configuration from UI config with defaults
  const searchConfig = useMemo(() => {
    const defaultSearchConfig = {
      enabled: true,
      placeholder: {
        en: 'Search apps...',
        de: 'Apps suchen...'
      },
      width: 'w-full sm:w-2/3 lg:w-1/3'
    };

    return uiConfig?.appsList?.search || defaultSearchConfig;
  }, [uiConfig]);

  const sortConfig = useMemo(() => {
    const defaultSortConfig = {
      enabled: true,
      default: 'relevance'
    };
    return uiConfig?.appsList?.sort || defaultSortConfig;
  }, [uiConfig]);

  const categoriesConfig = useMemo(() => {
    const defaultCategoriesConfig = {
      enabled: false,
      showAll: true,
      list: []
    };
    return uiConfig?.appsList?.categories || defaultCategoriesConfig;
  }, [uiConfig]);

  // State declarations must come before any useMemo/useEffect that references them
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [favoriteApps, setFavoriteApps] = useState([]);
  const [displayCount, setDisplayCount] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const recentAppIds = useMemo(() => getRecentAppIds(), []);
  const [sortMethod, setSortMethod] = useState(sortConfig.default || 'relevance');

  // Only display categories that contain at least one app, with smart hiding logic
  const availableCategories = useMemo(() => {
    if (!categoriesConfig.enabled) return [];

    // If only one app exists, don't show categories
    if (apps.length <= 1) return [];

    const usedCategories = new Set(apps.map(app => app.category || 'utility'));
    const filteredCategories = categoriesConfig.list.filter(category => {
      if (category.id === 'all') return categoriesConfig.showAll;
      return usedCategories.has(category.id);
    });

    // Count specific categories (excluding 'all')
    const specificCategories = filteredCategories.filter(cat => cat.id !== 'all');

    // If we only have 'all' and one specific category, don't show categories
    if (specificCategories.length <= 1) return [];

    return filteredCategories;
  }, [categoriesConfig, apps]);

  useEffect(() => {
    if (selectedCategory !== 'all') {
      const exists = apps.some(app => (app.category || 'utility') === selectedCategory);
      if (!exists) setSelectedCategory('all');
    }
  }, [apps, selectedCategory]);

  useEffect(() => {
    setSortMethod(sortConfig.default || 'relevance');
  }, [sortConfig]);

  const gridRef = useRef(null);
  const containerRef = useRef(null);

  // Calculate how many apps can fit in the viewport
  const calculateVisibleAppCount = useCallback(() => {
    if (!gridRef.current || !containerRef.current) return 9; // Default fallback

    const gridRect = gridRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();

    // Calculate available height for the grid
    // Consider the top part of the page and some padding for the load more button
    const headerHeight = gridRect.top - containerRect.top;
    const availableHeight = window.innerHeight - headerHeight - 120; // 120px for load more button and padding

    // Approximate height of each app card (you may need to adjust this)
    const appCardHeight = 250; // Typical height in pixels including margins

    // Calculate visible rows based on available height
    const visibleRows = Math.max(1, Math.floor(availableHeight / appCardHeight));

    // Calculate columns based on screen width (matches the grid-cols classes)
    let columns = 1;
    if (window.innerWidth >= 1024)
      columns = 3; // lg breakpoint
    else if (window.innerWidth >= 640) columns = 2; // sm breakpoint

    return visibleRows * columns;
  }, []);

  // Update display count when window is resized
  useEffect(() => {
    const handleResize = () => {
      const visibleCount = calculateVisibleAppCount();
      setDisplayCount(visibleCount);
    };

    // Calculate initial count
    handleResize();

    // Add resize listener
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [calculateVisibleAppCount]);

  // Load apps only once on mount and when language changes
  useEffect(() => {
    // Store mounted state to prevent state updates after unmount
    let isMounted = true;

    const loadApps = async () => {
      try {
        setLoading(true);

        // Add a small delay to allow i18n to fully initialize
        // This helps prevent the rapid re-renders
        await new Promise(resolve => setTimeout(resolve, 100));

        // Only proceed if still mounted
        if (!isMounted) return;

        console.log('Fetching apps data...');
        const appsData = await fetchApps();

        // Bail out if component unmounted during fetch
        if (!isMounted) return;

        // Safety check for empty or invalid data
        if (!appsData || !Array.isArray(appsData)) {
          console.error('Invalid apps data received:', appsData);
          setError(
            t('error.invalidDataFormat', 'Failed to load applications: Invalid data format')
          );
          setApps([]);
          return;
        }

        // Load favorite apps from localStorage
        const favorites = getFavoriteApps();

        // Batch our state updates to prevent multiple renders
        if (isMounted) {
          setApps(appsData);
          setFavoriteApps(favorites);
          setError(null);

          // Calculate visible app count after data is loaded
          const visibleCount = calculateVisibleAppCount();
          setDisplayCount(visibleCount);
        }
      } catch (err) {
        console.error('Error loading apps:', err);
        if (isMounted) {
          setError(
            t('error.loadingFailed', 'Failed to load applications. Please try again later.')
          );
          setApps([]); // Ensure apps is initialized as empty array on error
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadApps();

    // Cleanup function to handle component unmount
    return () => {
      isMounted = false;
    };
  }, [currentLanguage, user?.id, isAuthenticated, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset display count when search changes
  useEffect(() => {
    // Only reset if search is enabled and there are enough apps to show search
    if (searchConfig.enabled && apps.length > 3 && searchTerm) {
      const visibleCount = calculateVisibleAppCount();
      setDisplayCount(visibleCount);
    }
  }, [searchTerm, searchConfig.enabled, apps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Language change handler to ensure proper UI updates
  // Only re-render on actual language changes, not on every render
  const prevLanguageRef = useRef(currentLanguage);

  useEffect(() => {
    // Only update if the language actually changed from the previous value
    if (prevLanguageRef.current !== currentLanguage) {
      prevLanguageRef.current = currentLanguage;
      // No need to force a re-render - React will re-render naturally
      // when the language changes since the component uses translated content
    }
  }, [currentLanguage]);

  // Reset header color when component mounts
  useEffect(() => {
    resetHeaderColor();
  }, [resetHeaderColor]);

  // Direct search handler without debounce
  const handleSearchChange = useCallback(e => {
    const value = e.target.value;
    setSearchTerm(value);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const handleToggleFavorite = useCallback(
    (e, appId) => {
      e.preventDefault(); // Stop event propagation to avoid navigating to the app
      e.stopPropagation();

      const newStatus = toggleFavoriteApp(appId);
      // Update the favorite apps list in state
      if (newStatus) {
        setFavoriteApps(prev => [...prev, appId]);
      } else {
        setFavoriteApps(prev => prev.filter(id => id !== appId));
      }
    },
    [toggleFavoriteApp]
  );

  // Load more apps handler
  const handleLoadMore = useCallback(() => {
    // Increase by another viewport's worth of apps
    const increment = calculateVisibleAppCount();
    setDisplayCount(prev => prev + increment);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Category selection handler
  const handleCategorySelect = useCallback(
    categoryId => {
      setSelectedCategory(categoryId);
      // Reset display count when category changes
      const visibleCount = calculateVisibleAppCount();
      setDisplayCount(visibleCount);
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Memoized filtered apps to avoid recomputing on every render
  const filteredApps = useMemo(() => {
    return apps.filter(app => {
      try {
        // Safety check
        if (!app) return false;

        // Category filtering
        if (categoriesConfig.enabled && selectedCategory !== 'all') {
          const appCategory = app.category || 'utility'; // Default to 'utility' if no category
          if (appCategory !== selectedCategory) {
            return false;
          }
        }

        // Determine if search is enabled from config and app count
        const isSearchEnabled = searchConfig.enabled && apps.length > 3;

        // If search is disabled, show all apps (after category filter)
        if (!isSearchEnabled) {
          return true;
        }

        // Skip filtering if search term is empty
        if (searchTerm === '') {
          return true;
        }

        // Safely get localized content with fallbacks
        const appName = app.name ? getLocalizedContent(app.name, currentLanguage) || '' : '';
        const appDescription = app.description
          ? getLocalizedContent(app.description, currentLanguage) || ''
          : '';

        // Check for matches in name or description
        const nameMatches = appName.toLowerCase().includes(searchTerm.toLowerCase());
        const descriptionMatches = appDescription.toLowerCase().includes(searchTerm.toLowerCase());

        return nameMatches || descriptionMatches;
      } catch (err) {
        console.error('Error filtering app:', app, err);
        return false;
      }
    });
  }, [
    apps,
    searchTerm,
    currentLanguage,
    searchConfig.enabled,
    categoriesConfig.enabled,
    selectedCategory
  ]);

  // Memoized sorted apps to avoid recomputing on every render
  const sortedApps = useMemo(() => {
    const sortByDefault = (a, b) => {
      // Favorites first
      const aFav = favoriteApps.includes(a.id);
      const bFav = favoriteApps.includes(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;

      // Then sort by configured order
      const aHasOrder = a.order !== undefined && a.order !== null;
      const bHasOrder = b.order !== undefined && b.order !== null;
      if (aHasOrder && bHasOrder && a.order !== b.order) {
        return a.order - b.order;
      }
      if (aHasOrder && !bHasOrder) return -1;
      if (!aHasOrder && bHasOrder) return 1;

      // Fallback alphabetical
      const aName = getLocalizedContent(a.name, currentLanguage) || '';
      const bName = getLocalizedContent(b.name, currentLanguage) || '';
      return aName.localeCompare(bName);
    };

    const sortByRelevance = (a, b) => {
      const recentSet = new Set(recentAppIds);

      // Favorites first
      const aFav = favoriteApps.includes(a.id);
      const bFav = favoriteApps.includes(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;

      // Recently used next
      const aRecent = recentSet.has(a.id);
      const bRecent = recentSet.has(b.id);
      if (aRecent && !bRecent) return -1;
      if (!aRecent && bRecent) return 1;
      if (aRecent && bRecent) {
        return recentAppIds.indexOf(a.id) - recentAppIds.indexOf(b.id);
      }

      // Then sort by configured order
      const aHasOrder = a.order !== undefined && a.order !== null;
      const bHasOrder = b.order !== undefined && b.order !== null;
      if (aHasOrder && bHasOrder && a.order !== b.order) {
        return a.order - b.order;
      }
      if (aHasOrder && !bHasOrder) return -1;
      if (!aHasOrder && bHasOrder) return 1;

      // Fallback alphabetical
      const aName = getLocalizedContent(a.name, currentLanguage) || '';
      const bName = getLocalizedContent(b.name, currentLanguage) || '';
      return aName.localeCompare(bName);
    };

    const nameCompare = (a, b, dir = 'asc') => {
      const aName = getLocalizedContent(a.name, currentLanguage) || '';
      const bName = getLocalizedContent(b.name, currentLanguage) || '';
      return dir === 'asc' ? aName.localeCompare(bName) : bName.localeCompare(aName);
    };

    const list = [...filteredApps];

    if (sortMethod === 'relevance') {
      console.log('Sorting by relevance');
      return list.sort(sortByRelevance);
    }

    if (sortMethod === 'nameAsc') {
      console.log('Sorting by name ascending');
      return list.sort((a, b) => nameCompare(a, b, 'asc'));
    }

    if (sortMethod === 'nameDesc') {
      console.log('Sorting by name descending');
      return list.sort((a, b) => nameCompare(a, b, 'desc'));
    }

    return list.sort(sortByDefault);
  }, [filteredApps, favoriteApps, recentAppIds, currentLanguage, sortMethod]);

  // Memoized displayed apps for progressive loading
  const displayedApps = useMemo(() => {
    return sortedApps.slice(0, displayCount);
  }, [sortedApps, displayCount]);

  // Calculate whether there are more apps to load
  const hasMoreApps = displayedApps.length < sortedApps.length;

  if (loading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center">
        <LoadingSpinner message={t('app.loading')} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
          onClick={() => window.location.reload()}
        >
          {t('app.retry')}
        </button>
      </div>
    );
  }

  // Always show debugging info when no apps are available
  if (apps.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-yellow-500 mb-4">
          {t('error.noAppsAvailable', 'No apps available from server')}
        </div>
        <p className="mb-4">
          {t('error.checkServer', 'Check if the server is running and returning data correctly.')}
        </p>
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
          onClick={() => window.location.reload()}
        >
          {t('app.retry')}
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="container mx-auto py-8 px-4 flex flex-col">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2 flex items-center justify-center">
          <Icon
            name={uiConfig?.icons?.appsListLogo || 'apps-svg-logo'}
            className="text-indigo-600 w-[4rem] h-[4rem] mr-2"
          />
          {/* Use title from UI config if available, otherwise use translation */}
          {uiConfig?.appsList?.title
            ? getLocalizedContent(uiConfig.appsList.title, currentLanguage)
            : t('pages.appsList.title')}
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          {uiConfig?.appsList?.subtitle
            ? getLocalizedContent(uiConfig.appsList.subtitle, currentLanguage)
            : t('pages.appsList.subtitle')}
        </p>
      </div>

      {/* Conditional rendering of search based on configuration and app count */}
      {searchConfig.enabled && apps.length > 3 && (
        <div
          className={`flex flex-col sm:flex-row items-stretch gap-4 mb-4 mx-auto ${
            searchConfig.width || 'w-full sm:w-2/3 lg:w-1/3'
          }`}
        >
          <div className="relative flex-grow">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Icon name="search" className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder={
                getLocalizedContent(searchConfig.placeholder, currentLanguage) ||
                t('pages.appsList.searchPlaceholder')
              }
              value={searchTerm}
              onChange={handleSearchChange}
              className="block w-full pl-10 pr-10 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
            />
            {searchTerm && (
              <button
                onClick={clearSearch}
                className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600"
                aria-label={t('common.clearSearch', 'Clear search')}
              >
                <Icon name="x" className="w-5 h-5" />
              </button>
            )}
          </div>
          {sortConfig.enabled && (
            <div className="flex-shrink-0">
              <select
                className="h-full border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-lg py-2 px-3 w-full sm:w-auto"
                value={sortMethod}
                onChange={e => setSortMethod(e.target.value)}
              >
                <option value="relevance">{t('pages.appsList.sort.relevance', 'Relevance')}</option>
                <option value="nameAsc">{t('pages.appsList.sort.nameAsc', 'Name A-Z')}</option>
                <option value="nameDesc">{t('pages.appsList.sort.nameDesc', 'Name Z-A')}</option>
              </select>
            </div>
          )}
        </div>
      )}

      {/* Category filter */}
      {categoriesConfig.enabled && (
        <div className="flex flex-wrap gap-2 mb-6 justify-center">
          {availableCategories.map(category => (
            <button
              key={category.id}
              onClick={() => handleCategorySelect(category.id)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                selectedCategory === category.id
                  ? 'text-white shadow-lg transform scale-105'
                  : 'text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
              style={{
                backgroundColor: selectedCategory === category.id ? category.color : undefined
              }}
            >
              {getLocalizedContent(category.name, currentLanguage)}
            </button>
          ))}
        </div>
      )}

      {displayedApps.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500 dark:text-gray-400">{t('pages.appsList.noApps')}</p>
          {searchConfig.enabled && apps.length > 3 && searchTerm ? (
            <button
              onClick={() => {
                clearSearch();
              }}
              className="mt-4 px-4 py-2 text-indigo-600 border border-indigo-600 rounded hover:bg-indigo-50"
            >
              {t('pages.appsList.clearFilters')}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex justify-center w-full">
            <div
              ref={gridRef}
              className={`grid gap-6 ${
                displayedApps.length === 1
                  ? 'grid-cols-1 max-w-md mx-auto'
                  : displayedApps.length === 2
                    ? 'grid-cols-1 sm:grid-cols-2 max-w-2xl mx-auto'
                    : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
              }`}
              role="list"
              aria-label="Apps list"
            >
              {displayedApps.map(app => (
                <div
                  key={app.id}
                  className="relative bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:shadow-xl transition-shadow duration-300 w-full max-w-md"
                  role="listitem"
                >
                  <button
                    onClick={e => handleToggleFavorite(e, app.id)}
                    className="absolute top-2 right-2 z-10 p-1 bg-white dark:bg-gray-700 bg-opacity-70 rounded-full hover:bg-opacity-100 transition-all"
                    title={
                      favoriteApps.includes(app.id)
                        ? t('pages.appsList.unfavorite')
                        : t('pages.appsList.favorite')
                    }
                    aria-label={
                      favoriteApps.includes(app.id)
                        ? t('pages.appsList.unfavorite')
                        : t('pages.appsList.favorite')
                    }
                  >
                    <Icon
                      name="star"
                      className={
                        favoriteApps.includes(app.id) ? 'text-yellow-500' : 'text-gray-400'
                      }
                      solid={favoriteApps.includes(app.id)}
                    />
                  </button>
                  <Link
                    to={`/apps/${app.id}`}
                    className="block h-full"
                    aria-label={`Open ${getLocalizedContent(app.name, currentLanguage) || app.id} app`}
                  >
                    <div className="flex flex-row sm:flex-col h-full">
                      <div
                        className="flex items-center justify-center w-20 h-full flex-shrink-0 rounded-l-lg sm:rounded-t-lg sm:rounded-l-none sm:w-full sm:h-24 relative"
                        style={{ backgroundColor: app.color || '#4f46e5' }}
                      >
                        <div className="w-12 h-12 bg-white/30 rounded-full flex items-center justify-center">
                          <Icon
                            name={app.icon || 'lightning-bolt'}
                            size="xl"
                            className="text-white"
                          />
                        </div>
                        {/* App type badge */}
                        {app.type && app.type !== 'chat' && (
                          <div className="absolute bottom-2 right-2 bg-white/90 dark:bg-gray-800/90 px-2 py-0.5 rounded-full text-xs font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1">
                            <Icon
                              name={app.type === 'redirect' ? 'external-link' : 'window'}
                              size="xs"
                            />
                            {t(`pages.appsList.appTypes.${app.type}`)}
                          </div>
                        )}
                      </div>
                      <div className="px-4 py-2 flex flex-col flex-1">
                        <h3 className="font-bold text-lg mb-1 break-words">
                          {getLocalizedContent(app.name, currentLanguage) || app.id}
                          {favoriteApps.includes(app.id) && (
                            <span className="ml-2 hidden sm:inline-block" aria-label="Favorite">
                              <Icon
                                name="star"
                                size="sm"
                                className="text-yellow-500"
                                solid={true}
                              />
                            </span>
                          )}
                          {recentAppIds.includes(app.id) && (
                            <span
                              className="ml-1 inline-block"
                              aria-label={t('pages.appsList.recent')}
                              title={t('pages.appsList.recent')}
                            >
                              <Icon
                                name="clock"
                                size="sm"
                                className="text-indigo-600"
                                solid={true}
                              />
                            </span>
                          )}
                        </h3>
                        <p className="text-gray-600 dark:text-gray-400 text-sm flex-grow">
                          {getLocalizedContent(app.description, currentLanguage) || ''}
                        </p>
                      </div>
                    </div>
                  </Link>
                </div>
              ))}
            </div>
          </div>

          {/* Load More Button */}
          {hasMoreApps && (
            <div className="text-center mt-6">
              <button
                onClick={handleLoadMore}
                className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-indigo-600 dark:text-indigo-400 font-medium py-2 px-4 border border-indigo-500 rounded shadow-sm transition-colors"
              >
                {t('pages.appsList.loadMore', 'Load More')}
              </button>
              <p className="text-gray-500 dark:text-gray-400 text-sm mt-2">
                {t('pages.appsList.showingCountOfTotal', {
                  defaultValue: 'Showing {{displayed}} of {{total}} apps',
                  displayed: displayedApps.length,
                  total: sortedApps.length
                })}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AppsList;
