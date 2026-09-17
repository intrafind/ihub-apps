import { useState, useEffect, useMemo, useCallback } from 'react';
import { createFavoriteItemHelpers } from '../../utils/favoriteItems';

/**
 * React hook for localStorage-backed favorites that stays in sync across
 * components (via the `ihub:favorites-changed` event) and across browser tabs
 * (via the native `storage` event).
 *
 * @param {string} storageKey - localStorage key (e.g. 'ihub_favorite_apps')
 * @returns {{ favorites: string[], isFavorite: (id:string)=>boolean, toggleFavorite: (id:string)=>boolean }}
 */
export default function useFavorites(storageKey) {
  const helpers = useMemo(() => createFavoriteItemHelpers(storageKey), [storageKey]);
  const [favorites, setFavorites] = useState(() => helpers.getFavorites());

  useEffect(() => {
    const refresh = event => {
      // Same-tab custom event carries the storageKey; ignore other lists.
      if (event?.detail?.storageKey && event.detail.storageKey !== storageKey) return;
      // Cross-tab storage event carries `key`; ignore other keys.
      if (event?.type === 'storage' && event.key && event.key !== storageKey) return;
      setFavorites(helpers.getFavorites());
    };
    window.addEventListener('ihub:favorites-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('ihub:favorites-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [helpers, storageKey]);

  const toggleFavorite = useCallback(
    id => {
      const status = helpers.toggleFavorite(id);
      // toggleFavorite dispatches the custom event, but update locally too so
      // the calling component re-renders synchronously.
      setFavorites(helpers.getFavorites());
      return status;
    },
    [helpers]
  );

  const isFavorite = useCallback(id => favorites.includes(id), [favorites]);

  return { favorites, isFavorite, toggleFavorite };
}
