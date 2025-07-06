// Generic factory function for handling favorite items using localStorage

/**
 * Factory function that creates favorite item helpers for a given storage key
 * @param {string} storageKey - The localStorage key to use for storing favorites
 * @returns {Object} Object containing getFavorites, isFavorite, and toggleFavorite methods
 */
export const createFavoriteItemHelpers = (storageKey) => {
  /**
   * Get the list of favorite item IDs from localStorage
   * @returns {string[]} Array of favorited item IDs
   */
  const getFavorites = () => {
    try {
      const favorites = localStorage.getItem(storageKey);
      return favorites ? JSON.parse(favorites) : [];
    } catch (error) {
      console.error(`Error retrieving favorite items for ${storageKey}:`, error);
      return [];
    }
  };

  /**
   * Check if an item is marked as favorite
   * @param {string} itemId - The ID of the item to check
   * @returns {boolean} Whether the item is favorited
   */
  const isFavorite = (itemId) => {
    const favorites = getFavorites();
    return favorites.includes(itemId);
  };

  /**
   * Toggle the favorite status of an item
   * @param {string} itemId - The ID of the item to toggle
   * @returns {boolean} The new favorite status
   */
  const toggleFavorite = (itemId) => {
    try {
      const favorites = getFavorites();
      const isCurrentlyFavorite = favorites.includes(itemId);
      
      let newFavorites;
      if (isCurrentlyFavorite) {
        // Remove from favorites
        newFavorites = favorites.filter(id => id !== itemId);
      } else {
        // Add to favorites
        newFavorites = [...favorites, itemId];
      }
      
      localStorage.setItem(storageKey, JSON.stringify(newFavorites));
      return !isCurrentlyFavorite; // Return the new status
    } catch (error) {
      console.error(`Error toggling favorite item for ${storageKey}:`, error);
      return isFavorite(itemId); // Return the current status if there was an error
    }
  };

  return {
    getFavorites,
    isFavorite,
    toggleFavorite
  };
};
