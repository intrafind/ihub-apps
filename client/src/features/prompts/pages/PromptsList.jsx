import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { fetchPrompts } from '../../../api';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';
import PromptModal from '../components/PromptModal';
import { PromptScopeBadge } from '../components/PromptMeta';
import usePromptActions from '../hooks/usePromptActions';
import usePromptPreferences from '../hooks/usePromptPreferences';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { highlightVariables } from '../../../utils/highlightVariables';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useAuth } from '../../../shared/contexts/AuthContext';

const ITEMS_PER_PAGE = 9;

/** The scope filters, in the order they are offered. */
const SCOPE_FILTERS = ['all', 'mine', 'shared', 'global', 'favorites'];

function PromptsList() {
  const { t, i18n } = useTranslation();
  const [rawPrompts, setRawPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [copyStatus, setCopyStatus] = useState({});
  const [searchParams, setSearchParams] = useSearchParams();
  const { uiConfig } = useUIConfig();
  const { platformConfig } = usePlatformConfig();
  const { isAuthenticated } = useAuth();
  const {
    favorites: favoritePromptIds,
    recents: recentPromptIds,
    toggleFavorite
  } = usePromptPreferences();

  const userPromptsEnabled = isAuthenticated && platformConfig?.userPrompts?.enabled === true;
  const requestedFilter = searchParams.get('filter');
  const scopeFilter = SCOPE_FILTERS.includes(requestedFilter) ? requestedFilter : 'all';

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

  const [sortMethod, setSortMethod] = useState(sortConfig.default || 'relevance');

  useEffect(() => {
    setSortMethod(sortConfig.default || 'relevance');
  }, [sortConfig]);

  const loadPrompts = useCallback(
    async ({ fresh = false } = {}) => {
      try {
        const raw = await fetchPrompts({ skipCache: fresh });
        setRawPrompts(Array.isArray(raw) ? raw : []);
        setError(null);
      } catch (err) {
        console.error('Error loading prompts:', err);
        setError(t('error.loadingFailed', 'Failed to load prompts'));
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts, isAuthenticated]);

  const actions = usePromptActions({
    onChanged: useCallback(() => loadPrompts({ fresh: true }), [loadPrompts])
  });

  const prompts = useMemo(
    () =>
      rawPrompts.map(p => ({
        ...p,
        scope: p.scope || 'global',
        name: getLocalizedContent(p.name, i18n.language),
        prompt: getLocalizedContent(p.prompt, i18n.language),
        description: getLocalizedContent(p.description, i18n.language)
      })),
    [rawPrompts, i18n.language]
  );

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

  // Open the details if an id parameter is present
  useEffect(() => {
    const id = searchParams.get('id');
    if (id && prompts.some(p => p.id === id)) setSelectedId(id);
  }, [prompts, searchParams]);

  const selectedPrompt = prompts.find(p => p.id === selectedId) || null;

  const filteredPrompts = useMemo(() => {
    let filtered = prompts;

    if (scopeFilter === 'favorites') {
      const favs = new Set(favoritePromptIds);
      filtered = filtered.filter(p => favs.has(p.id));
    } else if (scopeFilter !== 'all') {
      filtered = filtered.filter(p => p.scope === scopeFilter);
    }

    // Filter by category if enabled
    if (categoriesConfig.enabled && selectedCategory !== 'all') {
      filtered = filtered.filter(p => (p.category || 'creative') === selectedCategory);
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        p =>
          p.name.toLowerCase().includes(term) ||
          p.prompt.toLowerCase().includes(term) ||
          (p.description && p.description.toLowerCase().includes(term)) ||
          (p.owner?.name && p.owner.name.toLowerCase().includes(term))
      );
    }

    return filtered;
  }, [
    prompts,
    scopeFilter,
    favoritePromptIds,
    searchTerm,
    categoriesConfig.enabled,
    selectedCategory
  ]);

  const sortedPrompts = useMemo(() => {
    if (!sortConfig.enabled) return filteredPrompts;

    const favs = new Set(favoritePromptIds);
    const recents = new Set(recentPromptIds);
    const sortByRelevance = (a, b) => {
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

  useEffect(() => {
    if (page > 0 && page >= totalPages) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  const handleSearchChange = e => {
    setSearchTerm(e.target.value);
    setPage(0);
  };

  const handlePrev = () => setPage(prev => Math.max(prev - 1, 0));
  const handleNext = () => setPage(prev => Math.min(prev + 1, totalPages - 1));

  const setScopeFilter = filter => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (filter === 'all') next.delete('filter');
        else next.set('filter', filter);
        return next;
      },
      { replace: true }
    );
    setPage(0);
  };

  const closeDetails = () => {
    setSelectedId(null);
    if (searchParams.get('id')) {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          next.delete('id');
          return next;
        },
        { replace: true }
      );
    }
  };

  const handleCopy = async p => {
    const copied = await actions.copy(p);
    if (copied === null) return;
    setCopyStatus(s => ({ ...s, [p.id]: copied ? 'success' : 'error' }));
    setTimeout(() => setCopyStatus(s => ({ ...s, [p.id]: 'idle' })), 2000);
  };

  const withClose = handler => p => {
    closeDetails();
    handler(p);
  };

  const handleCategorySelect = categoryId => {
    setSelectedCategory(categoryId);
    setPage(0); // Reset to first page when category changes
  };

  const filterLabels = {
    all: t('prompts.filters.all', 'All'),
    mine: t('prompts.filters.mine', 'My prompts'),
    shared: t('prompts.filters.shared', 'Shared with me'),
    global: t('prompts.filters.global', 'Global'),
    favorites: t('prompts.filters.favorites', 'Favorites')
  };
  const visibleFilters = SCOPE_FILTERS.filter(
    filter => userPromptsEnabled || (filter !== 'mine' && filter !== 'shared')
  );

  if (loading) {
    return <LoadingSpinner message={t('app.loading')} />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded-sm hover:bg-indigo-700"
          onClick={() => window.location.reload()}
        >
          {t('app.retry')}
        </button>
      </div>
    );
  }

  const emptyMessage =
    scopeFilter === 'mine' && !searchTerm
      ? t(
          'prompts.empty.mine',
          'You have no prompts yet. Create one, or save a chat message as a prompt.'
        )
      : scopeFilter === 'shared' && !searchTerm
        ? t('prompts.empty.shared', 'Nobody has shared a prompt with you yet.')
        : t('pages.promptsList.noPrompts', 'No prompts found');

  return (
    <div className="py-8 flex flex-col items-center px-4">
      <h1 className="text-3xl font-bold mb-2 text-gray-900 dark:text-gray-100">
        {t('pages.promptsList.title', 'Prompts')}
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        {t('pages.promptsList.subtitle', 'Browse available prompts')}
      </p>

      {actions.notice && (
        <div
          role="status"
          className={`mb-4 w-full max-w-xl flex items-center justify-between gap-3 rounded-md px-4 py-2 text-sm ${
            actions.notice.type === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
              : 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
          }`}
        >
          <span>{actions.notice.text}</span>
          <button
            type="button"
            onClick={actions.clearNotice}
            aria-label={t('common.close', 'Close')}
            className="opacity-70 hover:opacity-100"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}

      <div className="w-full max-w-md sm:max-w-lg lg:max-w-2xl mb-6">
        <div className="flex flex-col sm:flex-row items-stretch gap-4">
          <div className="relative grow">
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
            <div className="shrink-0">
              <select
                className="h-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg py-2 px-3 w-full sm:w-auto"
                value={sortMethod}
                aria-label={t('pages.promptsList.sort.label', 'Sort by')}
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
          {userPromptsEnabled && (
            <button
              type="button"
              onClick={() => actions.create()}
              className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <Icon name="plus" size="sm" />
              {t('prompts.actions.new', 'New prompt')}
            </button>
          )}
        </div>
      </div>

      {/* Scope filter */}
      <div
        className="flex flex-wrap gap-2 mb-4 justify-center"
        role="tablist"
        aria-label={t('prompts.filters.label', 'Show')}
      >
        {visibleFilters.map(filter => (
          <button
            key={filter}
            type="button"
            role="tab"
            aria-selected={scopeFilter === filter}
            onClick={() => setScopeFilter(filter)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              scopeFilter === filter
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            {filterLabels[filter]}
          </button>
        ))}
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
        <div className="text-center">
          <p className="text-gray-500 dark:text-gray-400">{emptyMessage}</p>
          {userPromptsEnabled && scopeFilter === 'mine' && !searchTerm && (
            <button
              type="button"
              onClick={() => actions.create()}
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <Icon name="plus" size="sm" />
              {t('prompts.actions.new', 'New prompt')}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 max-w-6xl mx-auto w-full">
            {pagePrompts.map(p => {
              const isFavorite = favoritePromptIds.includes(p.id);
              return (
                <div
                  key={p.id}
                  data-testid="prompt-card"
                  data-prompt-id={p.id}
                  className="group relative bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xs hover:shadow-md hover:border-indigo-300 dark:hover:border-indigo-600 transition-all duration-200 transform hover:-translate-y-0.5 cursor-pointer"
                  onClick={() => actions.use(p)}
                  onKeyDown={e => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      actions.use(p);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={t('prompts.actions.useNamed', {
                    defaultValue: 'Use prompt {{name}}',
                    name: p.name
                  })}
                >
                  <div className="p-4 h-full flex flex-col">
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        toggleFavorite(p.id);
                      }}
                      className="absolute top-3 right-3 z-10 p-1.5 bg-white/70 dark:bg-gray-700/70 rounded-full hover:bg-white dark:hover:bg-gray-700 transition-all"
                      title={
                        isFavorite
                          ? t('pages.promptsList.unfavorite')
                          : t('pages.promptsList.favorite')
                      }
                      aria-label={
                        isFavorite
                          ? t('pages.promptsList.unfavorite')
                          : t('pages.promptsList.favorite')
                      }
                    >
                      <Icon
                        name="star"
                        className={isFavorite ? 'text-yellow-500' : 'text-gray-400'}
                        solid={isFavorite}
                      />
                    </button>

                    <div className="flex items-start space-x-3 mb-2 pr-8">
                      <div className="shrink-0 w-8 h-8 bg-indigo-100 dark:bg-indigo-900/50 rounded-lg flex items-center justify-center group-hover:bg-indigo-200 dark:group-hover:bg-indigo-800/50 transition-colors">
                        <Icon
                          name={p.icon || 'clipboard'}
                          className="w-4 h-4 text-indigo-600 dark:text-indigo-400"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-5 mb-1 flex items-center flex-wrap">
                          {p.name}
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
                        </h3>
                        <div className="flex flex-wrap items-center gap-1">
                          {(userPromptsEnabled || p.scope !== 'global') && (
                            <PromptScopeBadge prompt={p} />
                          )}
                          {p.appId && (
                            <span className="px-1.5 py-0.5 text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/50 rounded-full">
                              {t('common.promptSearch.appSpecific', 'app')}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <p
                      className="text-xs text-gray-500 dark:text-gray-400 leading-4 grow overflow-hidden mb-4"
                      style={{
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical'
                      }}
                    >
                      {highlightVariables(p.description || p.prompt)}
                    </p>

                    <div className="flex flex-wrap gap-2 mt-auto justify-start">
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          actions.use(p);
                        }}
                        className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors flex items-center justify-center gap-1 whitespace-nowrap"
                      >
                        <Icon name="chat-bubble" size="sm" />
                        <span>{t('prompts.actions.use', 'Use in chat')}</span>
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          handleCopy(p);
                        }}
                        className="px-3 py-1.5 text-xs border border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/40 transition-colors flex items-center justify-center gap-1"
                      >
                        {copyStatus[p.id] === 'success' ? (
                          <Icon name="check-circle" size="sm" className="text-green-600" solid />
                        ) : copyStatus[p.id] === 'error' ? (
                          <Icon
                            name="exclamation-circle"
                            size="sm"
                            className="text-red-600"
                            solid
                          />
                        ) : (
                          <Icon name="copy" size="sm" />
                        )}
                        <span>{t('pages.promptsList.copyPrompt', 'Copy')}</span>
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedId(p.id);
                        }}
                        className="px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center justify-center"
                        aria-label={t('prompts.actions.details', 'Details')}
                        title={t('prompts.actions.details', 'Details')}
                      >
                        <Icon name="information-circle" size="sm" />
                      </button>
                      {p.permissions?.canEdit && (
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            actions.edit(p);
                          }}
                          className="px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center justify-center"
                          aria-label={t('common.edit', 'Edit')}
                          title={t('common.edit', 'Edit')}
                        >
                          <Icon name="pencil" size="sm" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="absolute inset-0 rounded-xl border border-transparent group-hover:border-indigo-200 dark:group-hover:border-indigo-700 transition-colors pointer-events-none"></div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-6">
              <button
                onClick={handlePrev}
                disabled={page === 0}
                className="px-3 py-1 border border-gray-300 dark:border-gray-600 rounded-sm text-indigo-600 dark:text-indigo-400 disabled:opacity-50"
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
                className="px-3 py-1 border border-gray-300 dark:border-gray-600 rounded-sm text-indigo-600 dark:text-indigo-400 disabled:opacity-50"
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
          onClose={closeDetails}
          isFavorite={favoritePromptIds.includes(selectedPrompt.id)}
          onToggleFavorite={toggleFavorite}
          onUse={withClose(actions.use)}
          onCopy={async p => {
            // The fill-in dialog opens on its own; two dialogs never share the screen.
            closeDetails();
            await handleCopy(p);
            return null;
          }}
          onEdit={userPromptsEnabled ? withClose(actions.edit) : undefined}
          onShare={userPromptsEnabled ? withClose(actions.share) : undefined}
          onDuplicate={userPromptsEnabled ? withClose(actions.duplicate) : undefined}
          onHistory={userPromptsEnabled ? withClose(actions.showHistory) : undefined}
          onDelete={userPromptsEnabled ? withClose(actions.remove) : undefined}
          t={t}
        />
      )}
      {actions.dialogs}
    </div>
  );
}

export default PromptsList;
