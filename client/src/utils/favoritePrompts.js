// Utility functions for handling favorite prompts using localStorage

import { createFavoriteItemHelpers } from './favoriteItems';

const FAVORITE_PROMPTS_KEY = 'aihub_favorite_prompts';

// Create the favorite helpers using the factory function
const { getFavorites, isFavorite, toggleFavorite } = createFavoriteItemHelpers(FAVORITE_PROMPTS_KEY);

// Export with prompt-specific names for backward compatibility
export const getFavoritePrompts = getFavorites;
export const isPromptFavorite = isFavorite;
export const toggleFavoritePrompt = toggleFavorite;
