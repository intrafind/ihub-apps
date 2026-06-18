import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchApps } from '../../../api/api';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import useFavorites from '../../../shared/hooks/useFavorites';
import { getRecentAppIds } from '../../../utils/recentApps';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { useAuth } from '../../../shared/contexts/AuthContext';
import Icon from '../../../shared/components/Icon';
import NextcloudSelectionBanner from '../../nextcloud-embed/components/NextcloudSelectionBanner';

// Instead of fixed values, we'll calculate based on viewport
function AppsList() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { resetHeaderColor, uiConfig } = useUIConfig();
  const { user, isAuthenticated } = useAuth();

  // Favorite apps (kept in sync across components + tabs by the hook)
  const { favorites: favoriteApps, isFavorite, toggleFavorite } = useFavorites('ihub_favorite_apps');

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

  // Calculate how many apps can fit in the viewport. The compact row layout is
  // much denser than the old banner cards, so we can show far more at once.
  const calculateVisibleAppCount = useCallback(() => {
    if (!gridRef.current || !containerRef.current) return 24; // Default fallback

    const gridRect = gridRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();

    // Calculate available height for the grid
    // Consider the top part of the page and some padding for the load more button
    const headerHeight = gridRect.top - containerRect.top;
    const availableHeight = window.innerHeight - headerHeight - 120; // 120px for load more button and padding

    // Approximate height of each compact app row (including the 12px grid gap).
    const appCardHeight = 78;

    // Calculate visible rows based on available height (with a little buffer).
    const visibleRows = Math.max(1, Math.floor(availableHeight / appCardHeight) + 1);

    // Columns follow the auto-fill grid (min 320px per column) within the
    // available grid width, so the count matches what's actually rendered.
    const gridWidth = gridRect.width || containerRect.width;
    const columns = Math.max(1, Math.floor(gridWidth / 320));

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

        // Batch our state updates to prevent multiple renders
        if (isMounted) {
          setApps(appsData);
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
  }, [currentLanguage, user?.id, isAuthenticated, t]); // eslint-disable-line @eslint-react/exhaustive-deps

  // Reset display count when search changes
  useEffect(() => {
    // Only reset if search is enabled and there are enough apps to show search
    if (searchConfig.enabled && apps.length > 3 && searchTerm) {
      const visibleCount = calculateVisibleAppCount();
      setDisplayCount(visibleCount);
    }
  }, [searchTerm, searchConfig.enabled, apps.length]); // eslint-disable-line @eslint-react/exhaustive-deps

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
      toggleFavorite(appId);
    },
    [toggleFavorite]
  );

  // Load more apps handler
  const handleLoadMore = useCallback(() => {
    // Increase by another viewport's worth of apps
    const increment = calculateVisibleAppCount();
    setDisplayCount(prev => prev + increment);
  }, []); // eslint-disable-line @eslint-react/exhaustive-deps

  // Category selection handler
  const handleCategorySelect = useCallback(
    categoryId => {
      setSelectedCategory(categoryId);
      // Reset display count when category changes
      const visibleCount = calculateVisibleAppCount();
      setDisplayCount(visibleCount);
    },
    [] // eslint-disable-line @eslint-react/exhaustive-deps
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
    <div ref={containerRef} className="min-h-full bg-gray-50 dark:bg-gray-900 px-6 py-10">
      <NextcloudSelectionBanner />
      <div className="max-w-6xl mx-auto">
        {/* Page header */}
        <div className="flex flex-col items-center text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">
            {uiConfig?.appsList?.title
              ? getLocalizedContent(uiConfig.appsList.title, currentLanguage)
              : t('pages.appsList.title')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {uiConfig?.appsList?.subtitle
              ? getLocalizedContent(uiConfig.appsList.subtitle, currentLanguage)
              : t('pages.appsList.subtitle')}
          </p>
        </div>

        {/* Search + sort */}
        {searchConfig.enabled && apps.length > 3 && (
          <div className="flex flex-col sm:flex-row items-stretch gap-3 mb-5 justify-center">
            <div className="relative" style={{ minWidth: 0, flex: '0 1 440px' }}>
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                <Icon name="search" className="h-5 w-5" />
              </span>
              <input
                type="text"
                placeholder={
                  getLocalizedContent(searchConfig.placeholder, currentLanguage) ||
                  t('pages.appsList.searchPlaceholder')
                }
                value={searchTerm}
                onChange={handleSearchChange}
                className="block w-full pl-12 pr-10 py-3 border border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-400 bg-white"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                aria-label={t('apps.searchApps', 'Search apps')}
              />
              {searchTerm && (
                <button
                  onClick={clearSearch}
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600"
                  aria-label={t('common.clearSearch', 'Clear search')}
                >
                  <Icon name="x" className="w-4 h-4" />
                </button>
              )}
            </div>
            {sortConfig.enabled && (
              <select
                className="border border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded-xl py-3 px-4 text-sm font-medium text-gray-600 dark:text-gray-300 cursor-pointer outline-none bg-white"
                value={sortMethod}
                onChange={e => setSortMethod(e.target.value)}
                aria-label={t('apps.sortBy', 'Sort by')}
              >
                <option value="relevance">{t('pages.appsList.sort.relevance', 'Relevance')}</option>
                <option value="nameAsc">{t('pages.appsList.sort.nameAsc', 'Name A-Z')}</option>
                <option value="nameDesc">{t('pages.appsList.sort.nameDesc', 'Name Z-A')}</option>
              </select>
            )}
          </div>
        )}

        {/* Category filter pills */}
        {categoriesConfig.enabled && availableCategories.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-7 justify-center">
            {availableCategories.map(category => (
              <button
                key={category.id}
                onClick={() => handleCategorySelect(category.id)}
                className={`px-5 py-2 rounded-full text-sm font-semibold transition-all ${
                  selectedCategory === category.id
                    ? 'text-white'
                    : 'text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
                style={{
                  backgroundColor: selectedCategory === category.id ? '#3a3f47' : undefined
                }}
              >
                {getLocalizedContent(category.name, currentLanguage)}
              </button>
            ))}
          </div>
        )}

        {displayedApps.length === 0 ? (
          <div className="text-center py-16">
            <Icon
              name="search"
              className="h-10 w-10 text-gray-300 dark:text-gray-600 mx-auto mb-3"
            />
            <p className="text-gray-500 dark:text-gray-400">{t('pages.appsList.noApps')}</p>
            {searchConfig.enabled && apps.length > 3 && searchTerm && (
              <button
                onClick={clearSearch}
                className="mt-4 px-4 py-2 text-indigo-600 border border-indigo-600 rounded-lg hover:bg-indigo-50 text-sm"
              >
                {t('pages.appsList.clearFilters')}
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Compact app rows grid */}
            <div
              ref={gridRef}
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
              role="list"
              aria-label={t('apps.appsList', 'Apps list')}
            >
              {displayedApps.map(app => {
                const name = getLocalizedContent(app.name, currentLanguage) || app.id;
                const desc = getLocalizedContent(app.description, currentLanguage) || '';
                const isFav = isFavorite(app.id);
                const favLabel = isFav
                  ? t('pages.appsList.unfavorite', 'Remove from favorites')
                  : t('pages.appsList.favorite', 'Add to favorites');
                return (
                  // Stretched-link pattern: a single full-row nav button plus a
                  // separate favorite button — no nested interactive elements.
                  <div
                    key={app.id}
                    role="listitem"
                    className="relative flex items-center gap-3 px-4 py-3.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md transition-all group"
                  >
                    <button
                      type="button"
                      onClick={() => navigate(`/apps/${app.id}`)}
                      aria-label={name}
                      className="absolute inset-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <span
                      className="w-11 h-11 rounded-xl flex items-center justify-center flex-none text-white pointer-events-none"
                      style={{ backgroundColor: app.color || '#4f46e5' }}
                    >
                      <Icon name={app.icon} size="md" />
                    </span>
                    <span className="flex-1 min-w-0 pointer-events-none">
                      <span className="block font-bold text-[15px] text-gray-900 dark:text-gray-100 truncate">
                        {name}
                      </span>
                      <span className="block text-[13px] text-gray-500 dark:text-gray-400 truncate leading-snug">
                        {desc}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={e => handleToggleFavorite(e, app.id)}
                      aria-pressed={isFav}
                      aria-label={favLabel}
                      title={favLabel}
                      className="relative z-10 w-8 h-8 flex-none flex items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-gray-100 dark:hover:bg-gray-700 transition-all"
                    >
                      <Icon
                        name="star"
                        size="sm"
                        className={isFav ? 'text-yellow-400' : 'text-gray-300'}
                        solid={isFav}
                      />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Load More */}
            {hasMoreApps && (
              <div className="text-center mt-8">
                <button
                  onClick={handleLoadMore}
                  className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-indigo-600 dark:text-indigo-400 font-medium py-2.5 px-6 border border-indigo-500 rounded-xl shadow-sm transition-colors text-sm"
                >
                  {t('pages.appsList.loadMore', 'Load More')}
                </button>
                <p className="text-gray-400 dark:text-gray-500 text-xs mt-2">
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
    </div>
  );
}

export default AppsList;
