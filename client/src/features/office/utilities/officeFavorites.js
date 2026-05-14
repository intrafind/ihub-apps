import { useEffect, useState, useCallback } from 'react';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';

export const OFFICE_FAVORITE_APPS_KEY = 'office_favoriteApps';

export const officeAppFavorites = createFavoriteItemHelpers(OFFICE_FAVORITE_APPS_KEY);

export function useOfficeFavoriteApps() {
  const [favorites, setFavorites] = useState(() => officeAppFavorites.getFavorites());

  useEffect(() => {
    const handleStorage = event => {
      if (event.key && event.key !== OFFICE_FAVORITE_APPS_KEY) return;
      setFavorites(officeAppFavorites.getFavorites());
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const toggle = useCallback(appId => {
    officeAppFavorites.toggleFavorite(appId);
    setFavorites(officeAppFavorites.getFavorites());
  }, []);

  return { favorites, toggleFavorite: toggle };
}
