import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchApps } from '../../api/api';
import { getLocalizedContent } from '../../utils/localizeContent';
import AppCard from './AppCard';
import Icon from './Icon';

/**
 * Compact, embeddable app list panel.
 *
 * Fetches apps via fetchApps() (uses apiClient — works with the Office auth interceptor).
 * Renders AppCard variant="compact" for each app.
 *
 * @param {Function} onSelect - Called with the selected app object
 * @param {string} [language='en'] - Locale for app name/description
 * @param {'auto'|boolean} [showSearch='auto'] - Show search when 'auto' and > 6 apps, or always/never
 * @param {React.ReactNode} [header] - Optional header node rendered above the list
 * @param {string[]} [favorites] - Optional list of favorited app IDs (enables favorite UI)
 * @param {Function} [onToggleFavorite] - Called as (event, appId) when the star is clicked
 */
function AppListPanel({
  onSelect,
  language = 'en',
  showSearch = 'auto',
  header,
  favorites,
  onToggleFavorite
}) {
  const { t } = useTranslation();
  const [apps, setApps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  useEffect(() => {
    fetchApps()
      .then(data => {
        if (Array.isArray(data)) setApps(data);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const shouldShowSearch = showSearch === 'auto' ? apps.length > 6 : showSearch === true;
  const favoriteIds = favorites || [];
  const favoritesEnabled = Boolean(onToggleFavorite);
  const hasFavorites = favoriteIds.length > 0;

  const visibleApps = useMemo(() => {
    let list = apps;
    if (favoritesEnabled && favoritesOnly) {
      list = list.filter(app => favoriteIds.includes(app.id));
    }
    if (shouldShowSearch && searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(app => {
        const name = getLocalizedContent(app.name, language) || '';
        const desc = getLocalizedContent(app.description, language) || '';
        return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
      });
    }
    if (!favoritesEnabled) return list;
    return [...list].sort((a, b) => {
      const aFav = favoriteIds.includes(a.id);
      const bFav = favoriteIds.includes(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      const aName = getLocalizedContent(a.name, language) || a.id || '';
      const bName = getLocalizedContent(b.name, language) || b.id || '';
      return aName.localeCompare(bName);
    });
  }, [apps, favoritesEnabled, favoritesOnly, favoriteIds, shouldShowSearch, searchQuery, language]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {header}
      {(shouldShowSearch || (favoritesEnabled && hasFavorites)) && (
        <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-2">
          {shouldShowSearch && (
            <input
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('pages.appsList.searchPlaceholder', 'Search apps...')}
              className="flex-1 px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          )}
          {favoritesEnabled && hasFavorites && (
            <button
              type="button"
              onClick={() => setFavoritesOnly(prev => !prev)}
              aria-pressed={favoritesOnly}
              title={favoritesOnly ? 'Show all apps' : 'Show favourites only'}
              className={`flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium border transition-colors shrink-0 ${
                favoritesOnly
                  ? 'bg-yellow-50 border-yellow-300 text-yellow-700'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Icon
                name="star"
                size="xs"
                className={favoritesOnly ? 'text-yellow-500' : 'text-slate-400'}
                solid={favoritesOnly}
              />
              {t('pages.appsList.favorites', 'Favourites')}
            </button>
          )}
        </div>
      )}
      <div className="relative flex-1 overflow-y-auto">
        <div className="p-4 grid gap-4 grid-cols-1">
          {visibleApps.map(app => (
            <AppCard
              key={app.id}
              app={app}
              variant="compact"
              onClick={onSelect}
              language={language}
              isFavorite={favoritesEnabled ? favoriteIds.includes(app.id) : false}
              onToggleFavorite={favoritesEnabled ? onToggleFavorite : undefined}
            />
          ))}
          {!isLoading && visibleApps.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">
              {favoritesEnabled && favoritesOnly
                ? t('pages.appsList.noFavorites', 'No favourite apps yet')
                : t('pages.appsList.noApps', 'No apps available')}
            </p>
          )}
        </div>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin" />
              <span className="text-sm text-slate-500">
                {t('pages.appsList.loading', 'Loading…')}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AppListPanel;
