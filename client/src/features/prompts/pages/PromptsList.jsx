import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { fetchPrompts, fetchSkills, fetchUserSkills } from '../../../api';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';
import PromptModal from '../components/PromptModal';
import { PromptScopeBadge } from '../components/PromptMeta';
import LibraryNewMenu from '../components/LibraryNewMenu';
import usePromptActions from '../hooks/usePromptActions';
import usePromptPreferences from '../hooks/usePromptPreferences';
import SkillCard from '../../skills/components/SkillCard';
import SkillDetailsModal from '../../skills/components/SkillDetailsModal';
import useSkillActions from '../../skills/hooks/useSkillActions';
import useSkillBuilder from '../../skills/hooks/useSkillBuilder';
import { skillErrorMessage } from '../../skills/utils/skillErrors';
import { pickerSkillScope } from '../../skills/utils/skillPicker';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { highlightVariables } from '../../../utils/highlightVariables';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useAuth } from '../../../shared/contexts/AuthContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

const ITEMS_PER_PAGE = 9;

/** The scope filters, in the order they are offered. */
const SCOPE_FILTERS = ['all', 'mine', 'shared', 'global', 'favorites'];

/**
 * The kinds of items the library holds, in the order the type switch offers
 * them (`?type=`). `all` shows every kind; each other entry names the item
 * `_type` it shows and whether it can be favorited. Another kind of item
 * (e.g. integrations) is one more entry here, plus its loader and its card.
 */
const ITEM_TYPES = [
  { id: 'all' },
  { id: 'prompts', itemType: 'prompt', favorites: true },
  { id: 'skills', itemType: 'skill', favorites: false }
];

/**
 * The global skills of `GET /api/skills` as library entries. That list also
 * carries the caller's personal skills; those come with more detail from
 * `/api/user-skills` and are left out here.
 *
 * @param {Object[]} raw - The `/api/skills` list.
 * @returns {Object[]}
 */
function toGlobalSkillEntries(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(skill => skill?.name && pickerSkillScope(skill) === 'global')
    .map(skill => ({
      ...skill,
      _type: 'skill',
      id: skill.id || skill.name,
      scope: 'global',
      description: skill.description || ''
    }));
}

/**
 * One group of the library's filter bar: mutually exclusive options shown as a
 * segmented control (a `tablist`, labelled by `label`).
 *
 * @param {Object} props
 * @param {string} props.label - Accessible name of the group.
 * @param {Array<{id: string, label: string}>} props.options - The options, in order.
 * @param {string} props.value - The selected option's id.
 * @param {(id: string) => void} props.onChange - Called with the picked option's id.
 */
function SegmentedControl({ label, options, value, onChange }) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap justify-center gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800"
    >
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          className={`h-8 shrink-0 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 ${
            value === option.id
              ? 'bg-white text-indigo-700 shadow-xs dark:bg-gray-600 dark:text-white'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The library at `/prompts`: prompts and — with the `skills` feature —
 * skills, each the caller's own, shared with them, or global. A type switch
 * (`?type=all|prompts|skills`) narrows the kind, the scope filter
 * (`?filter=`) the origin; `?id=` opens a prompt, `?skill=` a skill.
 */
function PromptsList() {
  const { t, i18n } = useTranslation();
  const [rawPrompts, setRawPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedSkillId, setSelectedSkillId] = useState(null);
  const [globalSkills, setGlobalSkills] = useState([]);
  const [personalSkills, setPersonalSkills] = useState([]);
  const [skillsError, setSkillsError] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [copyStatus, setCopyStatus] = useState({});
  const [searchParams, setSearchParams] = useSearchParams();
  const { uiConfig } = useUIConfig();
  const { platformConfig } = usePlatformConfig();
  const { isAuthenticated } = useAuth();
  const featureFlags = useFeatureFlags();
  const {
    favorites: favoritePromptIds,
    recents: recentPromptIds,
    toggleFavorite
  } = usePromptPreferences();

  const userPromptsEnabled = isAuthenticated && platformConfig?.userPrompts?.enabled === true;
  // Skills join the library with the skills feature; creating and changing
  // them needs personal skills enabled for a signed-in user.
  const skillsAvailable = featureFlags.isEnabled('skills', false);
  const userSkillsEnabled =
    skillsAvailable && isAuthenticated && platformConfig?.userSkills?.enabled === true;
  // Skills from the marketplace: offered when the server says there is one
  // to browse (the marketplace feature, the setting and a fetched catalog).
  const skillMarketplaceEnabled =
    userSkillsEnabled && platformConfig?.userSkills?.marketplace === true;

  // The kinds on offer: without skills the library is the prompt list it was.
  const itemTypes = ITEM_TYPES.filter(type => type.id !== 'skills' || skillsAvailable);
  const showTypeSwitch = itemTypes.length > 2;
  const requestedType = searchParams.get('type');
  const typeFilter =
    showTypeSwitch && itemTypes.some(type => type.id === requestedType) ? requestedType : 'all';
  const shownTypes = itemTypes.filter(
    type => type.itemType && (typeFilter === 'all' || type.id === typeFilter)
  );
  const shownItemTypes = shownTypes.map(type => type.itemType);
  const showsPrompts = shownItemTypes.includes('prompt');
  const showsSkills = shownItemTypes.includes('skill');

  // Mine/Shared exist for a kind its user may keep; Favorites only for kinds
  // that can be favorited (prompts, not skills).
  const visibleFilters = SCOPE_FILTERS.filter(filter => {
    if (filter === 'mine' || filter === 'shared') {
      return (showsPrompts && userPromptsEnabled) || (showsSkills && userSkillsEnabled);
    }
    if (filter === 'favorites') return shownTypes.some(type => type.favorites);
    return true;
  });
  const requestedFilter = searchParams.get('filter');
  const scopeFilter = visibleFilters.includes(requestedFilter) ? requestedFilter : 'all';

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

  const loadSkills = useCallback(
    async ({ fresh = false } = {}) => {
      if (!skillsAvailable) {
        setGlobalSkills([]);
        setPersonalSkills([]);
        return;
      }
      const [globalResult, personalResult] = await Promise.allSettled([
        fetchSkills(undefined, { skipCache: fresh }),
        userSkillsEnabled ? fetchUserSkills('all') : Promise.resolve([])
      ]);
      if (globalResult.status === 'fulfilled') {
        setGlobalSkills(toGlobalSkillEntries(globalResult.value));
      } else {
        console.error('Error loading skills:', globalResult.reason);
      }
      if (personalResult.status === 'fulfilled') {
        const list = Array.isArray(personalResult.value) ? personalResult.value : [];
        setPersonalSkills(
          list.map(skill => ({
            ...skill,
            _type: 'skill',
            scope: skill.scope || 'mine',
            description: skill.description || ''
          }))
        );
      } else {
        console.error('Error loading personal skills:', personalResult.reason);
      }
      const failed = [globalResult, personalResult].find(result => result.status === 'rejected');
      setSkillsError(failed ? skillErrorMessage(failed.reason, t) : null);
    },
    [skillsAvailable, userSkillsEnabled, t]
  );

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const skillActions = useSkillActions({
    onChanged: useCallback(() => loadSkills({ fresh: true }), [loadSkills])
  });
  // "Create skill with AI": a chat with the global skill-builder skill, where
  // the user describes the skill and saves the drafted SKILL.md as a skill.
  const skillBuilder = useSkillBuilder({ enabled: userSkillsEnabled, globalSkills });

  const prompts = useMemo(
    () =>
      rawPrompts.map(p => ({
        ...p,
        _type: 'prompt',
        scope: p.scope || 'global',
        name: getLocalizedContent(p.name, i18n.language),
        prompt: getLocalizedContent(p.prompt, i18n.language),
        description: getLocalizedContent(p.description, i18n.language)
      })),
    [rawPrompts, i18n.language]
  );

  // Personal skills (newest first, as the server sends them), then global ones.
  const skills = useMemo(
    () => [...personalSkills, ...globalSkills],
    [personalSkills, globalSkills]
  );

  // Only offer categories that contain at least one prompt; "All categories"
  // is always the dropdown's first option.
  const availableCategories = useMemo(() => {
    if (!categoriesConfig.enabled) return [];
    const usedCategories = new Set(prompts.map(p => p.category || 'creative'));
    return categoriesConfig.list.filter(
      category => category.id !== 'all' && usedCategories.has(category.id)
    );
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
  // A picked card wins; otherwise a `?skill=` link opens that skill.
  const openSkillId = selectedSkillId ?? searchParams.get('skill');
  const selectedSkill = skills.find(skill => skill.id === openSkillId) || null;

  const filteredPrompts = useMemo(() => {
    let filtered = [...(showsPrompts ? prompts : []), ...(showsSkills ? skills : [])];

    if (scopeFilter === 'favorites') {
      const favs = new Set(favoritePromptIds);
      filtered = filtered.filter(p => p._type === 'prompt' && favs.has(p.id));
    } else if (scopeFilter !== 'all') {
      filtered = filtered.filter(p => p.scope === scopeFilter);
    }

    // Filter by category if enabled (prompts have categories, skills do not)
    if (categoriesConfig.enabled && selectedCategory !== 'all') {
      filtered = filtered.filter(
        p => p._type === 'prompt' && (p.category || 'creative') === selectedCategory
      );
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(p =>
        p._type === 'skill'
          ? [p.name, p.displayName, p.description, p.owner?.name].some(
              value => typeof value === 'string' && value.toLowerCase().includes(term)
            )
          : p.name.toLowerCase().includes(term) ||
            p.prompt.toLowerCase().includes(term) ||
            (p.description && p.description.toLowerCase().includes(term)) ||
            (p.owner?.name && p.owner.name.toLowerCase().includes(term))
      );
    }

    return filtered;
  }, [
    prompts,
    skills,
    showsPrompts,
    showsSkills,
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
    // Favorites and recents are prompt ids; a skill never ranks by them.
    const isFav = item => item._type === 'prompt' && favs.has(item.id);
    const isRecent = item => item._type === 'prompt' && recents.has(item.id);
    const sortByRelevance = (a, b) => {
      const aFav = isFav(a);
      const bFav = isFav(b);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;

      const aRecent = isRecent(a);
      const bRecent = isRecent(b);
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

  const setTypeFilter = type => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (type === 'all') next.delete('type');
        else next.set('type', type);
        return next;
      },
      { replace: true }
    );
    setPage(0);
  };

  const closeDetails = () => {
    setSelectedId(null);
    setSelectedSkillId(null);
    if (searchParams.get('id') || searchParams.get('skill')) {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          next.delete('id');
          next.delete('skill');
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

  // "My prompts" when only prompts show, "Mine" once skills are in the list.
  const filterLabels = {
    all: t('prompts.filters.all', 'All'),
    mine: showsSkills
      ? showsPrompts
        ? t('library.filters.mine', 'Mine')
        : t('skills.filters.mine', 'My skills')
      : t('prompts.filters.mine', 'My prompts'),
    shared: t('prompts.filters.shared', 'Shared with me'),
    global: t('prompts.filters.global', 'Global'),
    favorites: t('prompts.filters.favorites', 'Favorites')
  };
  // Categories belong to prompts; skills have none.
  const showCategoryFilter =
    categoriesConfig.enabled && showsPrompts && availableCategories.length > 0;
  const selectedCategoryConfig =
    availableCategories.find(category => category.id === selectedCategory) || null;
  const typeLabels = {
    all: t('library.types.all', 'All'),
    prompts: t('library.types.prompts', 'Prompts'),
    skills: t('library.types.skills', 'Skills')
  };
  const newEntries = [
    userPromptsEnabled && {
      id: 'prompt',
      icon: 'clipboard',
      label: t('prompts.actions.new', 'New prompt'),
      onSelect: () => actions.create()
    },
    userSkillsEnabled && {
      id: 'skill',
      icon: 'sparkles',
      label: t('skills.actions.new', 'New skill'),
      onSelect: () => skillActions.create()
    },
    skillBuilder.app && {
      id: 'skill-ai',
      itemType: 'skill',
      icon: 'chat-bubble',
      label: t('skills.actions.createWithAi', 'Create skill with AI'),
      onSelect: skillBuilder.start
    },
    skillMarketplaceEnabled && {
      id: 'skill-marketplace',
      itemType: 'skill',
      icon: 'squares-2x2',
      label: t('skills.actions.fromMarketplace', 'Skill from the marketplace'),
      onSelect: () => skillActions.browseMarketplace()
    }
  ].filter(Boolean);
  // The empty "Mine" view offers to create what it shows (an entry's item type
  // is its `itemType`, else its id).
  const newEntriesForType = newEntries.filter(entry =>
    shownItemTypes.includes(entry.itemType || entry.id)
  );
  // Someone without skills of their own, looking at skills, gets pointed at
  // ready-made ones — writing a first skill from scratch is the hard way in.
  const showSkillsGetStarted =
    skillMarketplaceEnabled &&
    typeFilter === 'skills' &&
    (scopeFilter === 'all' || scopeFilter === 'global') &&
    !personalSkills.some(skill => skill.scope === 'mine');

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

  const emptyMessages = showsSkills
    ? showsPrompts
      ? {
          mine: t('library.empty.mine', 'You have no prompts or skills yet.'),
          shared: t('library.empty.shared', 'Nobody has shared a prompt or skill with you yet.'),
          none: t('library.empty.none', 'Nothing found')
        }
      : {
          mine: skillMarketplaceEnabled
            ? t(
                'skills.empty.mineMarketplace',
                'You have no skills yet. Add a ready-made one from the marketplace, copy a global skill, or create your own.'
              )
            : t('skills.empty.mine', 'You have no skills yet. Create one, or copy a global skill.'),
          shared: t('skills.empty.shared', 'Nobody has shared a skill with you yet.'),
          global: t('skills.empty.global', 'No global skills are available to you.'),
          none: t('skills.empty.none', 'No skills found')
        }
    : {
        mine: t(
          'prompts.empty.mine',
          'You have no prompts yet. Create one, or save a chat message as a prompt.'
        ),
        shared: t('prompts.empty.shared', 'Nobody has shared a prompt with you yet.'),
        none: t('pages.promptsList.noPrompts', 'No prompts found')
      };
  const emptyMessage = (!searchTerm && emptyMessages[scopeFilter]) || emptyMessages.none;

  return (
    <div className="py-8 flex flex-col items-center px-4">
      <h1 className="text-3xl font-bold mb-2 text-gray-900 dark:text-gray-100">
        {showTypeSwitch ? t('library.title', 'Library') : t('pages.promptsList.title', 'Prompts')}
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mb-6 text-center">
        {showTypeSwitch
          ? t(
              'library.subtitle',
              'Prompts to start from and skills the assistant follows. Type / in a chat to use them.'
            )
          : t('pages.promptsList.subtitle', 'Browse available prompts')}
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

      {skillActions.notice && (
        <div
          role="status"
          className={`mb-4 w-full max-w-xl flex items-center justify-between gap-3 rounded-md px-4 py-2 text-sm ${
            skillActions.notice.type === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
              : 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
          }`}
        >
          <span>{skillActions.notice.text}</span>
          <button
            type="button"
            onClick={skillActions.clearNotice}
            aria-label={t('common.close', 'Close')}
            className="opacity-70 hover:opacity-100"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}

      {skillsError && showsSkills && (
        <div
          role="alert"
          className="mb-4 w-full max-w-xl rounded-md px-4 py-2 text-sm bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        >
          {skillsError}
        </div>
      )}

      {/* Toolbar: search, sort and "New" share one height */}
      <div className="w-full max-w-2xl mb-4 flex flex-wrap sm:flex-nowrap gap-3">
        <div className="relative w-full sm:w-auto sm:flex-1">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Icon name="search" className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            className="block h-10 w-full pl-10 pr-10 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder={
              showsSkills
                ? showsPrompts
                  ? t('library.searchPlaceholder', 'Search prompts and skills...')
                  : t('skills.list.searchPlaceholder', 'Search skills...')
                : t('pages.promptsList.searchPlaceholder', 'Search prompts...')
            }
            aria-label={t('library.searchLabel', 'Search the library')}
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
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
              aria-label={t('common.clear', 'Clear')}
            >
              <Icon name="x" className="w-5 h-5" />
            </button>
          )}
        </div>
        {sortConfig.enabled && (
          <select
            className="h-10 flex-1 sm:flex-none border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            value={sortMethod}
            aria-label={t('pages.promptsList.sort.label', 'Sort by')}
            onChange={e => {
              setSortMethod(e.target.value);
              setPage(0);
            }}
          >
            <option value="relevance">{t('pages.promptsList.sort.relevance', 'Relevance')}</option>
            <option value="nameAsc">{t('pages.promptsList.sort.nameAsc', 'Name A-Z')}</option>
            <option value="nameDesc">{t('pages.promptsList.sort.nameDesc', 'Name Z-A')}</option>
          </select>
        )}
        <LibraryNewMenu entries={newEntries} />
      </div>

      {/* Filter bar: item type (see ITEM_TYPES), scope and category in one row */}
      <div className="w-full max-w-6xl mb-6 flex flex-wrap items-center justify-center gap-3">
        {showTypeSwitch && (
          <SegmentedControl
            label={t('library.types.label', 'Type')}
            options={itemTypes.map(type => ({
              id: type.id,
              label: typeLabels[type.id] || type.id
            }))}
            value={typeFilter}
            onChange={setTypeFilter}
          />
        )}
        <SegmentedControl
          label={t('prompts.filters.label', 'Show')}
          options={visibleFilters.map(filter => ({ id: filter, label: filterLabels[filter] }))}
          value={scopeFilter}
          onChange={setScopeFilter}
        />
        {showCategoryFilter && (
          <div className="relative max-w-full">
            {selectedCategoryConfig && (
              <span
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full pointer-events-none"
                style={{ backgroundColor: selectedCategoryConfig.color || '#6B7280' }}
              />
            )}
            <select
              className={`h-10 max-w-full rounded-lg border-0 bg-gray-100 dark:bg-gray-800 pr-3 text-sm font-medium focus:ring-2 focus:ring-indigo-500 ${
                selectedCategoryConfig
                  ? 'pl-7 text-indigo-700 dark:text-white'
                  : 'pl-3 text-gray-600 dark:text-gray-300'
              }`}
              value={selectedCategory}
              aria-label={t('library.categories.label', 'Category')}
              onChange={e => handleCategorySelect(e.target.value)}
            >
              <option value="all">{t('library.categories.all', 'All categories')}</option>
              {availableCategories.map(category => (
                <option key={category.id} value={category.id}>
                  {getLocalizedContent(category.name, i18n.language)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {showSkillsGetStarted && (
        <div
          data-testid="skills-get-started"
          className="mb-6 w-full max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 px-4 py-3"
        >
          <div className="shrink-0 w-9 h-9 bg-purple-100 dark:bg-purple-900/60 rounded-lg flex items-center justify-center">
            <Icon name="sparkles" className="w-5 h-5 text-purple-600 dark:text-purple-300" />
          </div>
          <div className="grow text-sm">
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {t('skills.getStarted.title', 'New to skills? Start with a ready-made one.')}
            </p>
            <p className="text-gray-600 dark:text-gray-300">
              {t(
                'skills.getStarted.text',
                'Pick a skill from the marketplace, add it to your skills and use it with / in any chat. You can adapt it to how you work later.'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => skillActions.browseMarketplace()}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            <Icon name="squares-2x2" size="sm" />
            {t('skills.getStarted.browse', 'Browse the marketplace')}
          </button>
        </div>
      )}

      {filteredPrompts.length === 0 ? (
        <div className="text-center">
          <p className="text-gray-500 dark:text-gray-400">{emptyMessage}</p>
          {scopeFilter === 'mine' && !searchTerm && newEntriesForType.length > 0 && (
            <div className="mt-4 flex justify-center">
              <LibraryNewMenu entries={newEntriesForType} />
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 max-w-6xl mx-auto w-full">
            {pagePrompts.map(p => {
              if (p._type === 'skill') {
                return (
                  <SkillCard
                    key={`skill:${p.id}`}
                    skill={p}
                    userSkillsEnabled={userSkillsEnabled}
                    onOpen={skill => setSelectedSkillId(skill.id)}
                    onDuplicate={skillActions.duplicate}
                    onEdit={skillActions.edit}
                  />
                );
              }
              const isFavorite = favoritePromptIds.includes(p.id);
              return (
                <div
                  key={`prompt:${p.id}`}
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
                          void handleCopy(p);
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
      {selectedSkill && (
        <SkillDetailsModal
          skill={selectedSkill}
          onClose={closeDetails}
          onEdit={userSkillsEnabled ? withClose(skillActions.edit) : undefined}
          onShare={userSkillsEnabled ? withClose(skillActions.share) : undefined}
          onDuplicate={userSkillsEnabled ? withClose(skillActions.duplicate) : undefined}
          onHistory={userSkillsEnabled ? withClose(skillActions.showHistory) : undefined}
          onDelete={userSkillsEnabled ? withClose(skillActions.remove) : undefined}
        />
      )}
      {actions.dialogs}
      {skillActions.dialogs}
    </div>
  );
}

export default PromptsList;
