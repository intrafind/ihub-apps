// Utility functions for handling favorite apps using localStorage

const FAVORITE_APPS_KEY = 'aihub_favorite_apps';

/**
 * Get the list of favorite app IDs from localStorage
 * @returns {string[]} Array of favorited app IDs
 */
export const getFavoriteApps = () => {
  try {
    const favorites = localStorage.getItem(FAVORITE_APPS_KEY);
    return favorites ? JSON.parse(favorites) : [];
  } catch (error) {
    console.error('Error retrieving favorite apps:', error);
    return [];
  }
};

/**
 * Check if an app is marked as favorite
 * @param {string} appId - The ID of the app to check
 * @returns {boolean} Whether the app is favorited
 */
export const isAppFavorite = (appId) => {
  const favorites = getFavoriteApps();
  return favorites.includes(appId);
};

/**
 * Toggle the favorite status of an app
 * @param {string} appId - The ID of the app to toggle
 * @returns {boolean} The new favorite status
 */
export const toggleFavoriteApp = (appId) => {
  try {
    const favorites = getFavoriteApps();
    const isFavorite = favorites.includes(appId);
    
    let newFavorites;
    if (isFavorite) {
      // Remove from favorites
      newFavorites = favorites.filter(id => id !== appId);
    } else {
      // Add to favorites
      newFavorites = [...favorites, appId];
    }
    
    localStorage.setItem(FAVORITE_APPS_KEY, JSON.stringify(newFavorites));
    return !isFavorite; // Return the new status
  } catch (error) {
    console.error('Error toggling favorite app:', error);
    return isAppFavorite(appId); // Return the current status if there was an error
  }
};