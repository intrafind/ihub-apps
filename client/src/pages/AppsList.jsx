import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { fetchApps } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';
import { getFavoriteApps, isAppFavorite, toggleFavoriteApp } from '../utils/favoriteApps';
import { useHeaderColor } from '../components/HeaderColorContext';

const INITIAL_DISPLAY_COUNT = 9; // Number of apps to show initially
const LOAD_MORE_COUNT = 6; // Number of apps to load each time "Load more" is clicked

const AppsList = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { resetHeaderColor } = useHeaderColor();
  
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [categories, setCategories] = useState([]);
  const [favoriteApps, setFavoriteApps] = useState([]);
  const [displayCount, setDisplayCount] = useState(INITIAL_DISPLAY_COUNT);
  const [translationsLoaded, setTranslationsLoaded] = useState(false);

  // Load apps with debounced search
  useEffect(() => {
    const loadApps = async () => {
      try {
        setLoading(true);
        const appsData = await fetchApps();
        
        // Safety check for empty or invalid data
        if (!appsData || !Array.isArray(appsData)) {
          console.error('Invalid apps data received:', appsData);
          setError(t('error.invalidDataFormat', 'Failed to load applications: Invalid data format'));
          setApps([]);
          return;
        }
        
        setApps(appsData);
        
        // Extract unique categories
        const uniqueCategories = [...new Set(appsData
          .filter(app => app.category)
          .map(app => app.category))
        ];
        setCategories(uniqueCategories);
        
        // Load favorite apps from localStorage
        setFavoriteApps(getFavoriteApps());
        
        setError(null);
      } catch (err) {
        console.error('Error loading apps:', err);
        setError(t('error.loadingFailed', 'Failed to load applications. Please try again later.'));
        setApps([]); // Ensure apps is initialized as empty array on error
      } finally {
        setLoading(false);
      }
    };
    
    loadApps();
  }, [t]);

  // Effect to monitor translation loading completeness
  useEffect(() => {
    // Subscribe to i18next's "loaded" event
    const handleTranslationsLoaded = (loaded) => {
      if (loaded) {
        // Force a re-render when translations are fully loaded
        setTranslationsLoaded(true);
        setTimeout(() => setTranslationsLoaded(false), 100);
      }
    };

    i18n.on('loaded', handleTranslationsLoaded);
    
    return () => {
      i18n.off('loaded', handleTranslationsLoaded);
    };
  }, [i18n]);

  // Reset display count when search or category changes
  useEffect(() => {
    setDisplayCount(INITIAL_DISPLAY_COUNT);
  }, [searchTerm, selectedCategory]);

  // Language change handler to ensure proper UI updates
  useEffect(() => {
    // Force re-render when language changes to update all localized content
    const handleLanguageChange = () => {
      // Simply updating a state will trigger a re-render
      setDisplayCount(prev => prev);
    };
    
    handleLanguageChange();
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
    setDisplayCount(prev => prev + LOAD_MORE_COUNT);
  }, []);

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
      const aIsFavorite = favoriteApps.includes(a.id);
      const bIsFavorite = favoriteApps.includes(b.id);
      
      if (aIsFavorite && !bIsFavorite) return -1;
      if (!aIsFavorite && bIsFavorite) return 1;
      
      // Secondary sort by name if favorite status is the same
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
    <div className="container mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">{t('pages.appsList.title')}</h1>
        <p className="text-gray-600">{t('pages.appsList.subtitle')}</p>
      </div>
      
      <div className="flex flex-col md:flex-row justify-center mb-6 gap-4 max-w-3xl mx-auto">
        <div className="w-full md:w-1/2 lg:w-3/5">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              placeholder={t('pages.appsList.searchPlaceholder')}
              value={searchTerm}
              onChange={handleSearchChange}
              className="w-full pl-10 pr-10 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
            {searchTerm && (
              <button
                onClick={clearSearch}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                aria-label="Clear search"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        
        {categories.length > 0 && (
          <div className="w-full md:w-1/2 lg:w-2/5">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('pages.appsList.categories')}</label>
            <select
              value={selectedCategory}
              onChange={(e) => handleCategoryChange(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6" role="list" aria-label="Apps list">
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
                  <svg 
                    className={`w-5 h-5 ${favoriteApps.includes(app.id) ? 'text-yellow-500' : 'text-gray-400'}`} 
                    fill={favoriteApps.includes(app.id) ? 'currentColor' : 'none'} 
                    stroke="currentColor" 
                    viewBox="0 0 24 24" 
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={1.5} 
                      d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" 
                    />
                  </svg>
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
                      <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        {app.icon === 'chat-bubbles' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                        )}
                        {app.icon === 'document-text' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        )}
                        {app.icon === 'globe' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        )}
                        {app.icon === 'sparkles' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                        )}
                        {app.icon === 'mail' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        )}
                        {app.icon === 'calendar' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        )}
                        {app.icon === 'share' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                        )}
                        {app.icon === 'document-search' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 21h7a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v11m0 5l4.879-4.879m0 0a3 3 0 104.243-4.242 3 3 0 00-4.243 4.242z" />
                        )}
                        {app.icon === 'users' && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                        )}
                        {/* Default icon if none of the above match */}
                        {!['chat-bubbles', 'document-text', 'globe', 'sparkles', 'mail', 'calendar', 'share', 'document-search', 'users'].includes(app.icon) && (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        )}
                      </svg>
                    </div>
                  </div>
                  <div className="p-4 h-[calc(100%-6rem)] flex flex-col">
                    <h3 className="font-bold text-lg mb-1 break-words">
                      {getLocalizedContent(app.name, currentLanguage) || app.id}
                      {favoriteApps.includes(app.id) && (
                        <span className="ml-2 inline-block" aria-label="Favorite">
                          <svg 
                            className="w-4 h-4 text-yellow-500 inline-block" 
                            fill="currentColor" 
                            viewBox="0 0 24 24" 
                            xmlns="http://www.w3.org/2000/svg"
                            aria-hidden="true"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                          </svg>
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
            <div className="text-center mt-8">
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