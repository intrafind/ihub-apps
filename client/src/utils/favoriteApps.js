// Utility functions for handling favorite apps using localStorage

import { createFavoriteItemHelpers } from './favoriteItems';

const FAVORITE_APPS_KEY = 'aihub_favorite_apps';

// Create the favorite helpers using the factory function
const { getFavorites, isFavorite, toggleFavorite } = createFavoriteItemHelpers(FAVORITE_APPS_KEY);

// Export with app-specific names for backward compatibility
export const getFavoriteApps = getFavorites;
export const isAppFavorite = isFavorite;
export const toggleFavoriteApp = toggleFavorite;