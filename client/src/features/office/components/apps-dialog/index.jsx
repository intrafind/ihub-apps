import { useEffect, useMemo, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import AppCard from '../../../../shared/components/AppCard';
import Icon from '../../../../shared/components/Icon';
import { officeLocale } from '../../utilities/officeLocale';
import { useOfficeFavoriteApps } from '../../utilities/officeFavorites';
import { getLocalizedContent } from '../../../../utils/localizeContent';

export default function ItemSelectorDialog({ items, isOpen, onSelect, onClose }) {
  const { favorites, toggleFavorite } = useOfficeFavoriteApps();
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handler = e => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const sortedItems = useMemo(() => {
    if (!Array.isArray(items)) return [];
    const compareName = (a, b) => {
      const aName = getLocalizedContent(a.name, officeLocale) || a.id || '';
      const bName = getLocalizedContent(b.name, officeLocale) || b.id || '';
      return aName.localeCompare(bName);
    };
    const list = favoritesOnly ? items.filter(item => favorites.includes(item.id)) : [...items];
    return list.sort((a, b) => {
      const aFav = favorites.includes(a.id);
      const bFav = favorites.includes(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      return compareName(a, b);
    });
  }, [items, favorites, favoritesOnly]);

  if (!isOpen) return null;

  const handleToggleFavorite = (_event, appId) => {
    toggleFavorite(appId);
  };

  const hasFavorites = favorites.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 shrink-0">
          <h2 className="text-base font-semibold text-slate-900">Select an App</h2>
          <div className="flex items-center gap-2">
            {hasFavorites && (
              <button
                type="button"
                onClick={() => setFavoritesOnly(prev => !prev)}
                aria-pressed={favoritesOnly}
                title={favoritesOnly ? 'Show all apps' : 'Show favourites only'}
                className={`flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium border transition-colors ${
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
                Favourites
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
            >
              <XMarkIcon className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto p-4">
          <div className="grid gap-3 grid-cols-1">
            {sortedItems.length ? (
              sortedItems.map(item => (
                <AppCard
                  key={item.id}
                  app={item}
                  variant="compact"
                  onClick={onSelect}
                  language={officeLocale}
                  isFavorite={favorites.includes(item.id)}
                  onToggleFavorite={handleToggleFavorite}
                />
              ))
            ) : (
              <p className="px-4 py-2 text-sm text-slate-400">
                {favoritesOnly ? 'No favourite apps yet' : 'No apps available'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
