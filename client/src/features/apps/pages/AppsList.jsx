// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useApps from '../../../shared/hooks/useApps';
import { invalidateAppsCache } from '../../../shared/hooks/appsCache';
import { invalidateUserAppsConfig, useUserAppsConfig } from '../../../shared/hooks/useUserApps';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import useFavorites from '../../../shared/hooks/useFavorites';
import { getRecentAppIds } from '../../../utils/recentApps';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import Icon from '../../../shared/components/Icon';
import NextcloudSelectionBanner from '../../nextcloud-embed/components/NextcloudSelectionBanner';
import PendingDocumentBanner from '../components/PendingDocumentBanner';
import UserAppBadge, { isUserApp, userAppScope } from '../components/UserAppBadge';
import MoreActionsMenu from '../../admin/components/MoreActionsMenu';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useRadioGroup from '../../../shared/hooks/useRadioGroup';
import { deleteUserApp, duplicateUserApp, leaveUserApp } from '../../../api';
import { userAppErrorMessage } from '../components/user-app/userAppErrors';
import usePendingDocumentCheck from '../hooks/usePendingDocumentCheck';
import {
  appCanTakeDocument,
  pendingDocumentQuery,
  readPendingDocument,
  withoutPendingDocument
} from '../utils/pendingDocument';

/** The scope chips of the apps page, in the order they are shown. */
const SCOPES = ['all', 'mine', 'shared'];

/**
 * The category an app is filed under. Categories apply to admin apps only: a
 * personal app has none and appears under "All" categories.
 */
const categoryOf = app => (isUserApp(app) ? null : app.category || 'utility');

// Instead of fixed values, we'll calculate based on viewport
function AppsList() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { resetHeaderColor, uiConfig } = useUIConfig();

  // Favorite apps (kept in sync across components + tabs by the hook)
  const {
    favorites: favoriteApps,
    isFavorite,
    toggleFavorite
  } = useFavorites('ihub_favorite_apps');

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

  // Apps come from the shared store (one request for sidebar, start page and
  // this list; refreshed together when any of them refetches).
  const { apps, loading, error: appsError } = useApps();
  const error = appsError
    ? t('error.loadingFailed', 'Failed to load applications. Please try again later.')
    : null;
  const [searchTerm, setSearchTerm] = useState('');
  const [displayCount, setDisplayCount] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState('all');

  // Personal apps. With the feature off (or for an anonymous viewer) `personal.enabled`
  // is false, nothing is asked of the server and the page is the one it was.
  const personal = useUserAppsConfig();
  const personalOn = personal.enabled;
  const canCreateUserApp = personalOn && personal.config?.canCreate === true;
  const maxUserApps = Number(personal.config?.maxApps) || 0;
  const userAppLimitReached =
    canCreateUserApp && maxUserApps > 0 && Number(personal.config?.used) >= maxUserApps;
  const [scope, setScope] = useState('all');
  const activeScope = personalOn ? scope : 'all';
  const scopeCounts = useMemo(() => {
    const counts = { mine: 0, shared: 0 };
    for (const app of apps) {
      const appScope = userAppScope(app);
      if (appScope) counts[appScope] += 1;
    }
    return counts;
  }, [apps]);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [actionError, setActionError] = useState(null);
  // What an action of a tile did, for the status line screen readers announce.
  const [actionStatus, setActionStatus] = useState('');
  // Where the focus goes once the list shows the result of an action of a tile:
  // `{ appId }` (the copy) or `{ scope: true }` (the selected scope chip).
  const [focusAfterAction, setFocusAfterAction] = useState(null);
  const appName = useCallback(
    app => getLocalizedContent(app?.name, currentLanguage) || app?.id || '',
    [currentLanguage]
  );

  const refreshUserApps = useCallback(() => {
    invalidateAppsCache();
    invalidateUserAppsConfig();
  }, []);

  const handleDuplicate = useCallback(
    async app => {
      setActionError(null);
      setActionStatus('');
      try {
        const copy = await duplicateUserApp(app.id);
        refreshUserApps();
        setScope('mine');
        setActionStatus(t('userApps.create.created', { name: appName(copy) }));
        if (copy?.id) setFocusAfterAction({ appId: copy.id });
      } catch (err) {
        setActionError(userAppErrorMessage(err, t));
      }
    },
    [refreshUserApps, t, appName]
  );

  const handleLeave = useCallback(
    async app => {
      setActionError(null);
      setActionStatus('');
      try {
        await leaveUserApp(app.id);
        refreshUserApps();
        setActionStatus(t('userApps.list.status.left', { name: appName(app) }));
        setFocusAfterAction({ scope: true });
      } catch (err) {
        setActionError(userAppErrorMessage(err, t));
      }
    },
    [refreshUserApps, t, appName]
  );

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    setActionStatus('');
    try {
      await deleteUserApp(pendingDelete.id);
      setActionStatus(t('userApps.list.status.deleted', { name: appName(pendingDelete) }));
      setPendingDelete(null);
      refreshUserApps();
      setFocusAfterAction({ scope: true });
    } catch (err) {
      setDeleteError(userAppErrorMessage(err, t));
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, refreshUserApps, t, appName]);

  /** The "⋯" entries of a personal tile: what the server says the caller may do. */
  const userAppMenuItems = useCallback(
    app => {
      const permissions = app.permissions || {};
      const items = [];
      // The receiver of an offer answers it in the editor, read-only with the
      // offer banner (design 11.7).
      if (permissions.canAcceptOffer === true) {
        items.push({
          id: 'viewOffer',
          label: t('userApps.list.menu.viewOffer'),
          onSelect: () => navigate(`/apps/${encodeURIComponent(app.id)}/edit`)
        });
      }
      if (permissions.canEdit === true) {
        items.push({
          id: 'edit',
          label: t('userApps.list.menu.edit'),
          onSelect: () => navigate(`/apps/${encodeURIComponent(app.id)}/edit`)
        });
      }
      if (permissions.canShare === true) {
        items.push({
          id: 'share',
          label: t('userApps.list.menu.share'),
          onSelect: () => navigate(`/apps/${encodeURIComponent(app.id)}/edit?dialog=share`)
        });
      }
      if (permissions.canUse === true && canCreateUserApp) {
        items.push({
          id: 'duplicate',
          label: t('userApps.list.menu.duplicate'),
          disabled: userAppLimitReached,
          onSelect: () => void handleDuplicate(app)
        });
      }
      if (permissions.canDelete === true) {
        items.push({
          id: 'delete',
          label: t('userApps.list.menu.delete'),
          destructive: true,
          onSelect: () => {
            setDeleteError(null);
            setPendingDelete(app);
          }
        });
      }
      // Only a share that names the caller can be left; access through a group
      // or through everyone cannot (design 11.5). The server says which.
      if (permissions.canLeave === true) {
        items.push({
          id: 'leave',
          label: t('userApps.list.menu.leave'),
          onSelect: () => void handleLeave(app)
        });
      }
      return items;
    },
    [t, navigate, canCreateUserApp, userAppLimitReached, handleDuplicate, handleLeave]
  );
  const recentAppIds = useMemo(() => getRecentAppIds(), []);
  const [sortMethod, setSortMethod] = useState(sortConfig.default || 'relevance');

  // A document waiting for an app (`/apps?documentId=…&source=…`, e.g. "Open in iHub" from
  // iFinder). It stays in the URL while the user browses and travels on to the app they pick,
  // where AppChat attaches it and strips it. One the user cannot read is not handed on: the
  // banner says why, and the app opens without it.
  const pendingDocument = useMemo(() => readPendingDocument(searchParams), [searchParams]);
  const documentCheck = usePendingDocumentCheck(pendingDocument);
  const documentUnusable = ['unavailable', 'noAccess', 'notFound'].includes(documentCheck.status);
  const readableDocument = pendingDocument && !documentUnusable ? pendingDocument : null;
  // Which apps can take it needs the integration's answer (its id, definition and type are what an
  // app's bindings name); without one (the check failed) every app is offered.
  const documentApps = useMemo(
    () =>
      readableDocument && documentCheck.info
        ? apps.filter(app => appCanTakeDocument(app, documentCheck.info))
        : [],
    [readableDocument, documentCheck.info, apps]
  );
  // An installed integration whose documents no app can receive (none binds it): every app would
  // refuse the document, so the picker says so and hands nothing on. A provider that is not an
  // installation (`project`) has no definition and keeps going to every app.
  const noAppForDocument = Boolean(
    readableDocument &&
    !loading &&
    apps.length > 0 &&
    documentCheck.info?.definition &&
    documentApps.length === 0
  );
  const documentForApp = noAppForDocument ? null : readableDocument;
  const [onlyDocumentApps, setOnlyDocumentApps] = useState(true);
  const canRestrictToDocumentApps = documentApps.length > 0;
  const restrictToDocumentApps = canRestrictToDocumentApps && onlyDocumentApps;

  const dismissPendingDocument = useCallback(() => {
    const rest = withoutPendingDocument(searchParams).toString();
    navigate(rest ? `/apps?${rest}` : '/apps', { replace: true });
  }, [navigate, searchParams]);

  const openApp = useCallback(
    app => {
      // An app offered to the caller opens where the offer is answered.
      if (isUserApp(app) && app.permissions?.canAcceptOffer === true) {
        navigate(`/apps/${encodeURIComponent(app.id)}/edit`);
        return;
      }
      const query = pendingDocumentQuery(documentForApp);
      navigate(query ? `/apps/${app.id}?${query}` : `/apps/${app.id}`);
    },
    [navigate, documentForApp]
  );

  // Only display categories that contain at least one app, with smart hiding logic
  const availableCategories = useMemo(() => {
    if (!categoriesConfig.enabled) return [];

    // If only one app exists, don't show categories
    if (apps.length <= 1) return [];

    const usedCategories = new Set(apps.map(categoryOf));
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
      const exists = apps.some(app => categoryOf(app) === selectedCategory);
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

  // Size the grid once the apps are in.
  useEffect(() => {
    if (!loading) setDisplayCount(calculateVisibleAppCount());
  }, [loading, apps, calculateVisibleAppCount]);

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

  // Scope chip selection. The chips are a radiogroup: arrow keys move and select.
  const handleScopeSelect = useCallback(
    id => {
      setScope(id);
      setDisplayCount(calculateVisibleAppCount());
    },
    [calculateVisibleAppCount]
  );

  const scopeRadio = useRadioGroup({
    ids: SCOPES,
    selected: activeScope,
    onSelect: handleScopeSelect
  });

  // Memoized filtered apps to avoid recomputing on every render
  const filteredApps = useMemo(() => {
    return apps.filter(app => {
      try {
        // Safety check
        if (!app) return false;

        // A pending document narrows the picker to apps that can take it
        if (restrictToDocumentApps && !documentApps.includes(app)) return false;

        // Scope chips (personal apps). "All" leaves out a personal app the caller
        // cannot use right now; it stays listed under its own chip with its state.
        if (activeScope === 'all') {
          if (isUserApp(app) && app.permissions?.canUse !== true) return false;
        } else if (userAppScope(app) !== activeScope) {
          return false;
        }

        // Category filtering (admin apps; a personal app has no category)
        if (categoriesConfig.enabled && activeScope === 'all' && selectedCategory !== 'all') {
          if (categoryOf(app) !== selectedCategory) {
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
    selectedCategory,
    restrictToDocumentApps,
    documentApps,
    activeScope
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

  // After an action of a tile its trigger is gone or moved: the focus goes to
  // the copy once the list shows it, or to the selected scope chip.
  useEffect(() => {
    if (!focusAfterAction || loading) return;
    const root = containerRef.current;
    const target = focusAfterAction.appId
      ? [...(root?.querySelectorAll('[data-tile-id]') || [])].find(
          tile => tile.dataset.tileId === focusAfterAction.appId
        )
      : root?.querySelector('[role="radiogroup"] [aria-checked="true"]');
    if (!target) return;
    target.focus();

    setFocusAfterAction(null);
  }, [focusAfterAction, displayedApps, loading]);

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
          className="bg-indigo-600 text-white px-4 py-2 rounded-sm hover:bg-indigo-700"
          onClick={() => window.location.reload()}
        >
          {t('app.retry')}
        </button>
      </div>
    );
  }

  // Always show debugging info when no apps are available. With personal apps on,
  // an empty installation still offers the chips and "New app".
  if (apps.length === 0 && !personalOn) {
    const noAppsConfig = uiConfig?.errorPages?.noApps;
    return (
      <div className="text-center py-12">
        <div className="text-yellow-500 mb-4">
          {getLocalizedContent(noAppsConfig?.title, currentLanguage) ||
            t('error.noAppsAvailable', 'No apps available from server')}
        </div>
        <p className="mb-4">
          {getLocalizedContent(noAppsConfig?.message, currentLanguage) ||
            t('error.checkServer', 'Check if the server is running and returning data correctly.')}
        </p>
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded-sm hover:bg-indigo-700"
          onClick={() => window.location.reload()}
        >
          {t('app.retry')}
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="min-h-full px-6 py-10">
      <NextcloudSelectionBanner />
      <div className="max-w-6xl mx-auto">
        {pendingDocument && (
          <PendingDocumentBanner
            status={noAppForDocument ? 'noApp' : documentCheck.status}
            title={documentCheck.title || pendingDocument.prefill}
            onDismiss={dismissPendingDocument}
            canRestrict={canRestrictToDocumentApps}
            restrict={restrictToDocumentApps}
            onRestrictChange={setOnlyDocumentApps}
          />
        )}
        {/* Page header */}
        <div className="flex flex-col items-center text-center mb-8">
          {uiConfig?.icons?.appsListLogo && (
            <Icon
              name={uiConfig.icons.appsListLogo}
              className="w-10 h-10 text-indigo-600 dark:text-indigo-400 mb-3"
              aria-hidden="true"
            />
          )}
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

        {personalOn && (
          <div className="mb-5 flex flex-col items-center gap-3">
            <div
              role="radiogroup"
              aria-label={t('userApps.list.scope.label')}
              className="flex flex-wrap justify-center gap-2"
            >
              {SCOPES.map(id => {
                const selected = activeScope === id;
                return (
                  <button
                    key={id}
                    type="button"
                    {...scopeRadio(id)}
                    data-testid={`apps-scope-${id}`}
                    className={`px-4 py-2 rounded-full text-sm font-semibold transition-all focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 ${
                      selected
                        ? 'bg-indigo-600 text-white'
                        : 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                  >
                    {id === 'all' && t('userApps.list.scope.all')}
                    {id === 'mine' && `${t('userApps.list.scope.mine')} ${scopeCounts.mine}`}
                    {id === 'shared' && `${t('userApps.list.scope.shared')} ${scopeCounts.shared}`}
                  </button>
                );
              })}
            </div>
            {userAppLimitReached && (
              <p id="user-app-limit" className="text-sm text-gray-700 dark:text-gray-300">
                {t('userApps.list.limitReached', { max: maxUserApps })}
              </p>
            )}
            {actionError && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {actionError}
              </p>
            )}
            {/* Always mounted, so a screen reader announces each change. */}
            <p role="status" data-testid="user-apps-status" className="sr-only">
              {actionStatus}
            </p>
          </div>
        )}

        {/* Search + sort */}
        {searchConfig.enabled && apps.length > 3 && (
          <div className="flex flex-col sm:flex-row items-stretch gap-3 mb-5 justify-center">
            <div className={`relative min-w-0 ${searchConfig.width || 'w-full sm:w-2/3 lg:w-1/3'}`}>
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
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
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-500 hover:text-gray-600"
                  aria-label={t('common.clearSearch', 'Clear search')}
                >
                  <Icon name="x" className="w-4 h-4" />
                </button>
              )}
            </div>
            {sortConfig.enabled && (
              <select
                className="border border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded-xl py-3 px-4 text-sm font-medium text-gray-600 dark:text-gray-300 cursor-pointer outline-hidden bg-white"
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
        {categoriesConfig.enabled && activeScope === 'all' && availableCategories.length > 0 && (
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
                  backgroundColor:
                    selectedCategory === category.id ? category.color || '#3a3f47' : undefined
                }}
              >
                {getLocalizedContent(category.name, currentLanguage)}
              </button>
            ))}
          </div>
        )}

        {displayedApps.length === 0 && activeScope !== 'all' && !searchTerm ? (
          <div className="mx-auto max-w-xl py-12 text-center" data-testid="user-apps-empty">
            <p className="text-gray-700 dark:text-gray-300">
              {activeScope === 'mine'
                ? t('userApps.list.empty.mine')
                : t('userApps.list.empty.shared')}
            </p>
            {activeScope === 'mine' && canCreateUserApp && (
              <>
                <p className="mt-4 text-gray-700 dark:text-gray-300">
                  {t('userApps.list.empty.mineHint')}
                </p>
                <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
                  {t('userApps.create.limits')}
                </p>
              </>
            )}
          </div>
        ) : displayedApps.length === 0 ? (
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
              // Equal rows: a tile with a badge does not make its row taller than the others.
              className="grid auto-rows-fr gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
              role="list"
              aria-label={t('apps.appsList', 'Apps list')}
            >
              {displayedApps.map(app => {
                const name = getLocalizedContent(app.name, currentLanguage) || app.id;
                const desc = getLocalizedContent(app.description, currentLanguage) || '';
                const isFav = isFavorite(app.id);
                const menuItems = isUserApp(app) ? userAppMenuItems(app) : [];
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
                      onClick={() => openApp(app)}
                      data-tile-id={app.id}
                      aria-label={name}
                      className="absolute inset-0 rounded-xl focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                    />
                    <span
                      className="w-11 h-11 rounded-xl flex items-center justify-center flex-none text-white pointer-events-none"
                      style={{ backgroundColor: app.color || '#4f46e5' }}
                    >
                      <Icon name={app.icon} size="md" />
                    </span>
                    <span className="flex-1 min-w-0 pointer-events-none">
                      <span className="flex items-center gap-1.5 font-bold text-[0.9375rem] text-gray-900 dark:text-gray-100">
                        <span className="truncate">{name}</span>
                        {recentAppIds.includes(app.id) && (
                          <span
                            className="flex-none text-gray-500"
                            title={t('pages.appsList.recent', 'Recently used')}
                          >
                            <Icon name="clock" size="xs" aria-hidden="true" />
                            <span className="sr-only">
                              {t('pages.appsList.recent', 'Recently used')}
                            </span>
                          </span>
                        )}
                      </span>
                      <span className="block text-[0.8125rem] text-gray-500 dark:text-gray-400 truncate leading-snug">
                        {desc}
                      </span>
                      <UserAppBadge app={app} />
                    </span>
                    {menuItems.length > 0 && (
                      // Positioned without a z-index: above the full-tile button by
                      // order, and no stacking context that would trap the open menu
                      // under the trigger of the next tile.
                      <span className="relative flex-none">
                        <MoreActionsMenu
                          items={menuItems}
                          label={t('userApps.list.menu.label', { name })}
                        />
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={e => handleToggleFavorite(e, app.id)}
                      aria-pressed={isFav}
                      aria-label={favLabel}
                      title={favLabel}
                      className={`relative z-10 w-8 h-8 flex-none flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-all ${
                        // Keep the star discoverable on touch devices, where hover never fires.
                        isFav
                          ? 'opacity-100'
                          : 'opacity-50 group-hover:opacity-100 focus:opacity-100'
                      }`}
                    >
                      <Icon
                        name="star"
                        size="sm"
                        className={isFav ? 'text-amber-500' : 'text-gray-500 dark:text-gray-400'}
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
                  className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-indigo-600 dark:text-indigo-400 font-medium py-2.5 px-6 border border-indigo-500 rounded-xl shadow-xs transition-colors text-sm"
                >
                  {t('pages.appsList.loadMore', 'Load More')}
                </button>
                <p className="text-gray-500 dark:text-gray-400 text-xs mt-2">
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
      <ConfirmDialog
        isOpen={Boolean(pendingDelete)}
        title={t('userApps.edit.delete.title', {
          name: pendingDelete
            ? getLocalizedContent(pendingDelete.name, currentLanguage) || pendingDelete.id
            : ''
        })}
        message={t('userApps.edit.delete.body')}
        confirmLabel={t('userApps.list.menu.delete')}
        danger
        busy={deleting}
        error={deleteError}
        onConfirm={handleDelete}
        onDeny={() => setPendingDelete(null)}
      />
    </div>
  );
}

export default AppsList;
