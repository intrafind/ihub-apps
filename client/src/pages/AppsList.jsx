import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { fetchApps } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';
import { getFavoriteApps, isAppFavorite, toggleFavoriteApp } from '../utils/favoriteApps';
import { useUIConfig } from '../components/UIConfigContext';
import Icon from '../components/Icon';

// Instead of fixed values, we'll calculate based on viewport
const AppsList = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { resetHeaderColor } = useUIConfig();
  
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [categories, setCategories] = useState([]);
  const [favoriteApps, setFavoriteApps] = useState([]);
  const [displayCount, setDisplayCount] = useState(0);
  const [translationsLoaded, setTranslationsLoaded] = useState(false);
  
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
    if (window.innerWidth >= 1024) columns = 3; // lg breakpoint
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
          setError(t('error.invalidDataFormat', 'Failed to load applications: Invalid data format'));
          setApps([]);
          return;
        }
        
        // Extract unique categories before setting state
        const uniqueCategories = [...new Set(appsData
          .filter(app => app.category)
          .map(app => app.category))
        ];
        
        // Load favorite apps from localStorage
        const favorites = getFavoriteApps();
        
        // Batch our state updates to prevent multiple renders
        if (isMounted) {
          setApps(appsData);
          setCategories(uniqueCategories);
          setFavoriteApps(favorites);
          setError(null);
          
          // Calculate visible app count after data is loaded
          const visibleCount = calculateVisibleAppCount();
          setDisplayCount(visibleCount);
        }
      } catch (err) {
        console.error('Error loading apps:', err);
        if (isMounted) {
          setError(t('error.loadingFailed', 'Failed to load applications. Please try again later.'));
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
  }, [currentLanguage, calculateVisibleAppCount]); // Added calculateVisibleAppCount as dependency

  // Reset display count when search or category changes
  useEffect(() => {
    const visibleCount = calculateVisibleAppCount();
    setDisplayCount(visibleCount);
  }, [searchTerm, selectedCategory, calculateVisibleAppCount]);

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
  const handleSearchChange = useCallback((e) => {
    const value = e.target.value;
    setSearchTerm(value);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchTerm('');
  }, []);

  const handleCategoryChange = useCallback((category) => {
    setSelectedCategory(category);
  }, []);

  const handleToggleFavorite = useCallback((e, appId) => {
    e.preventDefault(); // Stop event propagation to avoid navigating to the app
    e.stopPropagation();
    
    const newStatus = toggleFavoriteApp(appId);
    // Update the favorite apps list in state
    if (newStatus) {
      setFavoriteApps(prev => [...prev, appId]);
    } else {
      setFavoriteApps(prev => prev.filter(id => id !== appId));
    }
  }, []);

  // Load more apps handler
  const handleLoadMore = useCallback(() => {
    // Increase by another viewport's worth of apps
    const increment = calculateVisibleAppCount();
    setDisplayCount(prev => prev + increment);
  }, [calculateVisibleAppCount]);

  // Memoized filtered apps to avoid recomputing on every render
  const filteredApps = useMemo(() => {
    return apps.filter(app => {
      try {
        // Safety check
        if (!app) return false;
        
        // Skip filtering if search and category are empty/default
        if (searchTerm === '' && selectedCategory === 'all') {
          return true;
        }
        
        // Safely get localized content with fallbacks
        const appName = app.name ? getLocalizedContent(app.name, currentLanguage) || '' : '';
        const appDescription = app.description ? getLocalizedContent(app.description, currentLanguage) || '' : '';
        
        const nameMatches = searchTerm === '' || 
                            appName.toLowerCase().includes(searchTerm.toLowerCase());
        
        const descriptionMatches = searchTerm === '' || 
                                  appDescription.toLowerCase().includes(searchTerm.toLowerCase());
        
        const categoryMatches = selectedCategory === 'all' || app.category === selectedCategory;
        
        return (nameMatches || descriptionMatches) && categoryMatches;
      } catch (err) {
        console.error('Error filtering app:', app, err);
        return false;
      }
    });
  }, [apps, searchTerm, selectedCategory, currentLanguage]);
  
  // Memoized sorted apps to avoid recomputing on every render
  const sortedApps = useMemo(() => {
    return [...filteredApps].sort((a, b) => {
      // First sort by favorite status
      const aIsFavorite = favoriteApps.includes(a.id);
      const bIsFavorite = favoriteApps.includes(b.id);
      
      if (aIsFavorite && !bIsFavorite) return -1;
      if (!aIsFavorite && bIsFavorite) return 1;
      
      // Then sort by order if available
      const aHasOrder = a.order !== undefined && a.order !== null;
      const bHasOrder = b.order !== undefined && b.order !== null;
      
      // If both have order, compare by order
      if (aHasOrder && bHasOrder) {
        return a.order - b.order;
      }
      
      // If only one has order, prioritize the one with order
      if (aHasOrder && !bHasOrder) return -1;
      if (!aHasOrder && bHasOrder) return 1;
      
      // Finally, sort by name if same favorite status and neither has order or both have same order
      const aName = getLocalizedContent(a.name, currentLanguage) || '';
      const bName = getLocalizedContent(b.name, currentLanguage) || '';
      return aName.localeCompare(bName);
    });
  }, [filteredApps, favoriteApps, currentLanguage]);
  
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
        <div className="text-yellow-500 mb-4">{t('error.noAppsAvailable', 'No apps available from server')}</div>
        <p className="mb-4">{t('error.checkServer', 'Check if the server is running and returning data correctly.')}</p>
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
    <div ref={containerRef} className="container mx-auto py-8 px-4 flex flex-col h-full">
      <div className="text-center mb-4">
        <h1 className="text-3xl font-bold mb-2 flex items-center justify-center">
          <Icon name="apps-svg-logo" className="text-indigo-600 w-8 h-8 mr-2" />
          {t('pages.appsList.title')}
        </h1>
        <p className="text-gray-600">{t('pages.appsList.subtitle')}</p>
      </div>
      
      {/* Responsive search container - full width on mobile, 1/3 width on larger screens */}
      <div className="flex flex-col gap-6 mb-4 mx-auto w-full sm:w-2/3 lg:w-1/3">
        <div className="w-full">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <Icon name="search" className="text-gray-400" />
            </div>
            <input
              type="text"
              placeholder={t('pages.appsList.searchPlaceholder')}
              value={searchTerm}
              onChange={handleSearchChange}
              className="w-full pl-12 pr-12 py-3 border rounded-lg text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
            {searchTerm && (
              <button
                onClick={clearSearch}
                className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600"
                aria-label="Clear search"
              >
                <Icon name="x" className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
        
        {categories.length > 0 && (
          <div className="w-full">
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('pages.appsList.categories')}</label>
            <select
              value={selectedCategory}
              onChange={(e) => handleCategoryChange(e.target.value)}
              className="w-full px-4 py-3 border rounded-lg text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="all">{t('pages.appsList.allCategories')}</option>
              {categories.map(category => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {displayedApps.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500">{t('pages.appsList.noApps')}</p>
          {searchTerm || selectedCategory !== 'all' ? (
            <button 
              onClick={() => {
                clearSearch();
                handleCategoryChange('all');
              }}
              className="mt-4 px-4 py-2 text-indigo-600 border border-indigo-600 rounded hover:bg-indigo-50"
            >
              {t('pages.appsList.clearFilters')}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div 
            ref={gridRef} 
            className={`grid ${displayedApps.length <= 2 ? 'justify-items-center mx-auto max-w-3xl' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6'} `}
            role="list" 
            aria-label="Apps list"
          >
            {displayedApps.map(app => (
              <div
                key={app.id}
                className="relative bg-white rounded-lg shadow-lg hover:shadow-xl transition-shadow duration-300"
                role="listitem"
              >
                <button 
                  onClick={(e) => handleToggleFavorite(e, app.id)}
                  className="absolute top-2 right-2 z-10 p-1 bg-white bg-opacity-70 rounded-full hover:bg-opacity-100 transition-all"
                  title={favoriteApps.includes(app.id) ? t('pages.appsList.unfavorite') : t('pages.appsList.favorite')}
                  aria-label={favoriteApps.includes(app.id) ? t('pages.appsList.unfavorite') : t('pages.appsList.favorite')}
                >
                  <Icon 
                    name="star" 
                    className={favoriteApps.includes(app.id) ? 'text-yellow-500' : 'text-gray-400'}
                    solid={favoriteApps.includes(app.id)}
                  />
                </button>
                <Link
                  to={`/apps/${app.id}`}
                  className="block h-full"
                  aria-label={`Open ${getLocalizedContent(app.name, currentLanguage) || app.id} app`}
                >
                  <div 
                    className="h-24 rounded-t-lg flex items-center justify-center"
                    style={{ backgroundColor: app.color || '#4f46e5' }}
                  >
                    <div className="w-12 h-12 bg-white/30 rounded-full flex items-center justify-center">
                      <Icon name={app.icon || 'lightning-bolt'} size="xl" className="text-white" />
                    </div>
                  </div>
                  <div className="px-4 p-2 h-[calc(100%-6rem)] flex flex-col">
                    <h3 className="font-bold text-lg mb-1 break-words">
                      {getLocalizedContent(app.name, currentLanguage) || app.id}
                      {favoriteApps.includes(app.id) && (
                        <span className="ml-2 inline-block" aria-label="Favorite">
                          <Icon name="star" size="sm" className="text-yellow-500" solid={true} />
                        </span>
                      )}
                    </h3>
                    <p className="text-gray-600 text-sm flex-grow">{getLocalizedContent(app.description, currentLanguage) || ''}</p>
                    {app.category && (
                      <div className="mt-3">
                        <span className="inline-block bg-gray-100 text-gray-700 px-2 py-1 rounded text-xs">
                          {app.category}
                        </span>
                      </div>
                    )}
                  </div>
                </Link>
              </div>
            ))}
          </div>
          
          {/* Load More Button */}
          {hasMoreApps && (
            <div className="text-center mt-6">
              <button
                onClick={handleLoadMore}
                className="bg-white hover:bg-gray-50 text-indigo-600 font-medium py-2 px-4 border border-indigo-500 rounded shadow-sm transition-colors"
              >
                {t('pages.appsList.loadMore', 'Load More')}
              </button>
              <p className="text-gray-500 text-sm mt-2">
                {t('pages.appsList.showingCountOfTotal', 'Showing {{displayed}} of {{total}} apps', {
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