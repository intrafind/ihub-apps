// Utility functions for handling favorite prompts using localStorage

const FAVORITE_PROMPTS_KEY = 'aihub_favorite_prompts';

export const getFavoritePrompts = () => {
  try {
    const favorites = localStorage.getItem(FAVORITE_PROMPTS_KEY);
    return favorites ? JSON.parse(favorites) : [];
  } catch (error) {
    console.error('Error retrieving favorite prompts:', error);
    return [];
  }
};

export const isPromptFavorite = (promptId) => {
  const favorites = getFavoritePrompts();
  return favorites.includes(promptId);
};

export const toggleFavoritePrompt = (promptId) => {
  try {
    const favorites = getFavoritePrompts();
    const isFavorite = favorites.includes(promptId);

    const newFavorites = isFavorite
      ? favorites.filter(id => id !== promptId)
      : [...favorites, promptId];

    localStorage.setItem(FAVORITE_PROMPTS_KEY, JSON.stringify(newFavorites));
    return !isFavorite;
  } catch (error) {
    console.error('Error toggling favorite prompt:', error);
    return isPromptFavorite(promptId);
  }
};
