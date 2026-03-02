import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchPrompts } from '../../../api/api';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';
import PromptModal from '../components/PromptModal';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import { getRecentPromptIds, recordPromptUsage } from '../../../utils/recentPrompts';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { highlightVariables } from '../../../utils/highlightVariables';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

const ITEMS_PER_PAGE = 9;

const PromptsList = () => {
  const { t, i18n } = useTranslation();
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(0);
  const [favoritePromptIds, setFavoritePromptIds] = useState([]);
  const [recentPromptIds, setRecentPromptIds] = useState([]);
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');

  // Create favorite prompts helpers
  const { getFavorites: getFavoritePrompts, toggleFavorite: toggleFavoritePrompt } =
    createFavoriteItemHelpers('ihub_favorite_prompts');
  const [copyStatus, setCopyStatus] = useState({});
  const [searchParams] = useSearchParams();
  const { uiConfig } = useUIConfig();

  const sortConfig = useMemo(() => {
    const defaultSortConfig = { enabled: true, default: 'relevance' };
    return uiConfig?.promptsList?.sort || defaultSortConfig;
  }, [uiConfig]);

  const categoriesConfig = useMemo(() => {
    const defaultCategoriesConfig = {
      enabled: false,
      showAll: true,
      list: []
    };
    return uiConfig?.promptsList?.categories || defaultCategoriesConfig;
  }, [uiConfig]);

  // Only display categories that contain at least one prompt
  const availableCategories = useMemo(() => {
    if (!categoriesConfig.enabled) return [];
    const usedCategories = new Set(prompts.map(p => p.category || 'creative'));
    return categoriesConfig.list.filter(category => {
      if (category.id === 'all') return categoriesConfig.showAll;
      return usedCategories.has(category.id);
    });
  }, [categoriesConfig, prompts]);

  useEffect(() => {
    if (selectedCategory !== 'all') {
      const exists = prompts.some(p => (p.category || 'creative') === selectedCategory);
      if (!exists) setSelectedCategory('all');
    }
  }, [prompts, selectedCategory]);

  const [sortMethod, setSortMethod] = useState(sortConfig.default || 'relevance');

  useEffect(() => {
    setSortMethod(sortConfig.default || 'relevance');
  }, [sortConfig]);

  useEffect(() => {
    (async () => {
      try {
        const raw = await fetchPrompts();
        const localized = (Array.isArray(raw) ? raw : []).map(p => ({
          ...p,
          name: getLocalizedContent(p.name, i18n.language),
          prompt: getLocalizedContent(p.prompt, i18n.language),
          description: getLocalizedContent(p.description, i18n.language)
        }));
        setPrompts(localized);
        setFavoritePromptIds(getFavoritePrompts());
        setRecentPromptIds(getRecentPromptIds());
        setError(null);
      } catch (err) {
        console.error('Error loading prompts:', err);
        setError(t('error.loadingFailed', 'Failed to load prompts'));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, i18n.language]);

  // Open modal if id parameter is present
  useEffect(() => {
    if (!prompts.length) return;
    const id = searchParams.get('id');
    if (id) {
      const found = prompts.find(p => p.id === id);
      if (found) setSelectedPrompt(found);
    }
  }, [prompts, searchParams]);

  const filteredPrompts = useMemo(() => {
    let filtered = prompts;

    // Filter by category if enabled
    if (categoriesConfig.enabled && selectedCategory !== 'all') {
      filtered = filtered.filter(p => {
        const promptCategory = p.category || 'creative'; // Default to 'creative' if no category
        return promptCategory === selectedCategory;
      });
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        p =>
          p.name.toLowerCase().includes(term) ||
          p.prompt.toLowerCase().includes(term) ||
          (p.description && p.description.toLowerCase().includes(term))
      );
    }

    return filtered;
  }, [prompts, searchTerm, categoriesConfig.enabled, selectedCategory]);

  const sortedPrompts = useMemo(() => {
    if (!sortConfig.enabled) return filteredPrompts;

    const sortByRelevance = (a, b) => {
      const favs = new Set(favoritePromptIds);
      const recents = new Set(recentPromptIds);

      const aFav = favs.has(a.id);
      const bFav = favs.has(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;

      const aRecent = recents.has(a.id);
      const bRecent = recents.has(b.id);
      if (aRecent && !bRecent) return -1;
      if (!aRecent && bRecent) return 1;
      if (aRecent && bRecent) {
        return recentPromptIds.indexOf(a.id) - recentPromptIds.indexOf(b.id);
      }

      return 0;
    };

    const nameCompare = (a, b, dir = 'asc') => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      return dir === 'asc' ? aName.localeCompare(bName) : bName.localeCompare(aName);
    };

    const list = [...filteredPrompts];

    if (sortMethod === 'nameAsc') {
      return list.sort((a, b) => nameCompare(a, b, 'asc'));
    }
    if (sortMethod === 'nameDesc') {
      return list.sort((a, b) => nameCompare(a, b, 'desc'));
    }

    return list.sort(sortByRelevance);
  }, [filteredPrompts, favoritePromptIds, recentPromptIds, sortMethod, sortConfig.enabled]);

  const totalPages = Math.ceil(sortedPrompts.length / ITEMS_PER_PAGE);
  const pagePrompts = sortedPrompts.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  const handleSearchChange = e => {
    setSearchTerm(e.target.value);
    setPage(0);
  };

  const handlePrev = () => setPage(prev => Math.max(prev - 1, 0));
  const handleNext = () => setPage(prev => Math.min(prev + 1, totalPages - 1));

  const handleToggleFavorite = (e, promptId) => {
    e.preventDefault();
    const newStatus = toggleFavoritePrompt(promptId);
    if (newStatus) {
      setFavoritePromptIds(prev => [...prev, promptId]);
    } else {
      setFavoritePromptIds(prev => prev.filter(id => id !== promptId));
    }
  };

  const handleCategorySelect = categoryId => {
    setSelectedCategory(categoryId);
    setPage(0); // Reset to first page when category changes
  };

  if (loading) {
    return <LoadingSpinner message={t('app.loading')} />;
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

  return (
    <div className="py-8 flex flex-col items-center">
      <h1 className="text-3xl font-bold mb-2 text-gray-900 dark:text-gray-100">
        {t('pages.promptsList.title', 'Prompts')}
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        {t('pages.promptsList.subtitle', 'Browse available prompts')}
      </p>

      <div className="w-full max-w-md sm:max-w-lg lg:max-w-xl mb-8">
        <div className="flex flex-col sm:flex-row items-stretch gap-4">
          <div className="relative flex-grow">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Icon name="search" className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              className="block w-full pl-10 pr-10 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              placeholder={t('pages.promptsList.searchPlaceholder', 'Search prompts...')}
              value={searchTerm}
              onChange={handleSearchChange}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm('');
                  setPage(0);
                }}
                className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600"
                aria-label={t('common.clear', 'Clear')}
              >
                <Icon name="x" className="w-5 h-5" />
              </button>
            )}
          </div>
          {sortConfig.enabled && (
            <div className="flex-shrink-0">
              <select
                className="h-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg py-2 px-3 w-full sm:w-auto"
                value={sortMethod}
                onChange={e => {
                  setSortMethod(e.target.value);
                  setPage(0);
                }}
              >
                <option value="relevance">
                  {t('pages.promptsList.sort.relevance', 'Relevance')}
                </option>
                <option value="nameAsc">{t('pages.promptsList.sort.nameAsc', 'Name A-Z')}</option>
                <option value="nameDesc">{t('pages.promptsList.sort.nameDesc', 'Name Z-A')}</option>
              </select>
            </div>
          )}
        </div>
      </div>

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
              {getLocalizedContent(category.name, i18n.language)}
            </button>
          ))}
        </div>
      )}

      {filteredPrompts.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400">
          {t('pages.promptsList.noPrompts', 'No prompts found')}
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 max-w-6xl mx-auto w-full">
            {pagePrompts.map(p => (
              <div
                key={p.id}
                className="group relative bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm hover:shadow-md hover:border-indigo-300 dark:hover:border-indigo-600 transition-all duration-200 transform hover:-translate-y-0.5 cursor-pointer"
                onClick={() => setSelectedPrompt(p)}
              >
                <div className="p-4 h-full flex flex-col">
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      handleToggleFavorite(e, p.id);
                    }}
                    className="absolute top-3 right-3 z-10 p-1.5 bg-white dark:bg-gray-700 bg-opacity-70 rounded-full hover:bg-opacity-100 transition-all"
                    title={
                      favoritePromptIds.includes(p.id)
                        ? t('pages.promptsList.unfavorite')
                        : t('pages.promptsList.favorite')
                    }
                    aria-label={
                      favoritePromptIds.includes(p.id)
                        ? t('pages.promptsList.unfavorite')
                        : t('pages.promptsList.favorite')
                    }
                  >
                    <Icon
                      name="star"
                      className={
                        favoritePromptIds.includes(p.id) ? 'text-yellow-500' : 'text-gray-400'
                      }
                      solid={favoritePromptIds.includes(p.id)}
                    />
                  </button>

                  <div className="flex items-start space-x-3 mb-3">
                    <div className="flex-shrink-0 w-8 h-8 bg-indigo-100 dark:bg-indigo-900/50 rounded-lg flex items-center justify-center group-hover:bg-indigo-200 dark:group-hover:bg-indigo-800/50 transition-colors">
                      <Icon
                        name={p.icon || 'clipboard'}
                        className="w-4 h-4 text-indigo-600 dark:text-indigo-400"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-5 mb-1 flex items-center flex-wrap">
                        {p.name}
                        {favoritePromptIds.includes(p.id) && (
                          <span
                            className="ml-1"
                            aria-label={t('pages.promptsList.favorite')}
                            title={t('pages.promptsList.favorite')}
                          >
                            <Icon name="star" size="sm" className="text-yellow-500" solid={true} />
                          </span>
                        )}
                        {recentPromptIds.includes(p.id) && (
                          <span
                            className="ml-1"
                            aria-label={t('pages.promptsList.recent')}
                            title={t('pages.promptsList.recent')}
                          >
                            <Icon
                              name="clock"
                              size="sm"
                              className="text-indigo-600 dark:text-indigo-400"
                              solid={true}
                            />
                          </span>
                        )}
                        {p.appId && (
                          <span className="ml-1 px-1.5 py-0.5 text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/50 rounded-full">
                            {t('common.promptSearch.appSpecific', 'app')}
                          </span>
                        )}
                      </h3>
                    </div>
                  </div>

                  <p
                    className="text-xs text-gray-500 dark:text-gray-400 leading-4 flex-grow overflow-hidden mb-4"
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical'
                    }}
                  >
                    {highlightVariables(p.description || p.prompt)}
                  </p>

                  <div className="flex gap-2 mt-auto justify-start">
                    <button
                      onClick={async e => {
                        e.stopPropagation();
                        try {
                          await navigator.clipboard.writeText(p.prompt.replace('[content]', ''));
                          setCopyStatus(s => ({ ...s, [p.id]: 'success' }));
                          recordPromptUsage(p.id);
                        } catch (err) {
                          console.error('Failed to copy prompt:', err);
                          setCopyStatus(s => ({ ...s, [p.id]: 'error' }));
                        }
                        setTimeout(() => {
                          setCopyStatus(s => ({ ...s, [p.id]: 'idle' }));
                        }, 2000);
                      }}
                      className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors flex items-center justify-center gap-1"
                    >
                      {copyStatus[p.id] === 'success' ? (
                        <Icon name="check-circle" size="sm" className="text-green-200" solid />
                      ) : copyStatus[p.id] === 'error' ? (
                        <Icon name="exclamation-circle" size="sm" className="text-red-200" solid />
                      ) : (
                        <Icon name="copy" size="sm" />
                      )}
                      <span>{t('pages.promptsList.copyPrompt', 'Copy')}</span>
                    </button>
                    {p.appId && (
                      <Link
                        to={`/apps/${p.appId}?prefill=${encodeURIComponent(p.prompt.replace('[content]', ''))}${p.variables && p.variables.length > 0 ? '&' + p.variables.map(v => `var_${v.name}=${encodeURIComponent(v.defaultValue || '')}`).join('&') : ''}`}
                        className="px-3 py-1.5 text-xs border border-indigo-600 text-indigo-600 rounded-lg hover:bg-indigo-50 transition-colors flex items-center justify-center gap-1"
                        onClick={e => {
                          e.stopPropagation();
                          recordPromptUsage(p.id);
                        }}
                      >
                        {t('pages.promptsList.useInApp', 'Open')}
                      </Link>
                    )}
                  </div>
                </div>
                <div className="absolute inset-0 rounded-xl border border-transparent group-hover:border-indigo-200 dark:group-hover:border-indigo-700 transition-colors pointer-events-none"></div>
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-6">
              <button
                onClick={handlePrev}
                disabled={page === 0}
                className="px-3 py-1 border border-gray-300 dark:border-gray-600 rounded text-indigo-600 dark:text-indigo-400 disabled:opacity-50"
              >
                {t('pages.promptsList.previous', 'Previous')}
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {t('pages.promptsList.pageOfTotal', {
                  defaultValue: 'Page {{current}} of {{total}}',
                  current: page + 1,
                  total: totalPages
                })}
              </span>
              <button
                onClick={handleNext}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 border border-gray-300 dark:border-gray-600 rounded text-indigo-600 dark:text-indigo-400 disabled:opacity-50"
              >
                {t('pages.promptsList.next', 'Next')}
              </button>
            </div>
          )}
        </>
      )}
      {selectedPrompt && (
        <PromptModal
          prompt={selectedPrompt}
          onClose={() => setSelectedPrompt(null)}
          isFavorite={favoritePromptIds.includes(selectedPrompt.id)}
          onToggleFavorite={id => {
            const newStatus = toggleFavoritePrompt(id);
            if (newStatus) {
              setFavoritePromptIds(prev => [...prev, id]);
            } else {
              setFavoritePromptIds(prev => prev.filter(pid => pid !== id));
            }
          }}
          t={t}
        />
      )}
    </div>
  );
};

export default PromptsList;
