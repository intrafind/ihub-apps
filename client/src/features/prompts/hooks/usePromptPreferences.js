import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  fetchPromptPreferences,
  recordPromptUsageOnServer,
  savePromptPreferences
} from '../../../api';
import { useOptionalAuth } from '../../../shared/contexts/authContextValue';
import { createFavoriteItemHelpers } from '../../../utils/favoriteItems';
import {
  getRecentPromptIds,
  recordPromptUsage as recordLocalPromptUsage
} from '../../../utils/recentPrompts';

/**
 * Prompt favorites and recents.
 *
 * A signed-in user keeps them on the server, so they follow the user to
 * another browser or device. The first time a user has nothing stored there,
 * whatever this browser remembered is carried over once. Anonymous visitors —
 * and installations whose storage is down — keep using the browser, as
 * before.
 *
 * One module-level store, so the library page, the `/` search and the sidebar
 * share one request and one answer.
 */

const LOCAL_FAVORITES_KEY = 'ihub_favorite_prompts';
const localFavorites = createFavoriteItemHelpers(LOCAL_FAVORITES_KEY);

/** Recents shown; the server keeps a few more. */
const MAX_RECENTS = 20;

let state = { key: null, favorites: [], recents: [], remote: false, loaded: false };
let pending = null;
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readLocal() {
  return { favorites: localFavorites.getFavorites(), recents: getRecentPromptIds() };
}

function applyServer(key, preferences) {
  if (state.key !== key) return;
  setState({
    favorites: Array.isArray(preferences?.favorites) ? preferences.favorites : [],
    recents: (Array.isArray(preferences?.recents) ? preferences.recents : []).map(r => r.id),
    remote: true,
    loaded: true
  });
}

function switchToLocal(key) {
  state = { key, ...readLocal(), remote: false, loaded: true };
  listeners.forEach(listener => listener());
}

function load(key) {
  if (state.key === key && (state.loaded || pending)) return;
  // Show what the browser knows while the server answers.
  state = { key, ...readLocal(), remote: false, loaded: false };
  listeners.forEach(listener => listener());
  pending = (async () => {
    try {
      const preferences = await fetchPromptPreferences();
      if (!preferences?.available) {
        if (state.key === key) switchToLocal(key);
        return;
      }
      if (!preferences.stored) {
        const local = readLocal();
        if (local.favorites.length > 0 || local.recents.length > 0) {
          const now = Date.now();
          const saved = await savePromptPreferences({
            favorites: local.favorites,
            // The browser kept the order, not the times: newest first, a
            // second apart, is the same order on the server.
            recents: local.recents.map((id, index) => ({
              id,
              at: new Date(now - index * 1000).toISOString()
            }))
          });
          applyServer(key, saved);
          return;
        }
      }
      applyServer(key, preferences);
    } catch {
      if (state.key === key) switchToLocal(key);
    } finally {
      pending = null;
    }
  })();
}

/**
 * @returns {{favorites: string[], recents: string[], loaded: boolean,
 *   isFavorite: (id: string) => boolean, toggleFavorite: (id: string) => boolean,
 *   recordUsage: (id: string) => void}}
 */
export default function usePromptPreferences() {
  const auth = useOptionalAuth();
  const user = auth?.user;
  const isAuthenticated = auth?.isAuthenticated === true;
  const key = isAuthenticated && user?.id ? `user:${user.id}` : 'anonymous';

  useEffect(() => {
    if (key === 'anonymous') {
      if (state.key !== key) switchToLocal(key);
    } else {
      load(key);
    }
  }, [key]);

  const snapshot = useSyncExternalStore(subscribe, () => state);
  const current = snapshot.key === key ? snapshot : { ...readLocal(), loaded: false };

  const toggleFavorite = useCallback(id => {
    const has = state.favorites.includes(id);
    const favorites = has ? state.favorites.filter(f => f !== id) : [...state.favorites, id];
    setState({ favorites });
    if (state.remote) {
      const key = state.key;
      savePromptPreferences({ favorites })
        .then(saved => applyServer(key, saved))
        .catch(() => {});
    } else {
      localFavorites.toggleFavorite(id);
    }
    return !has;
  }, []);

  const recordUsage = useCallback(id => {
    if (!id) return;
    setState({ recents: [id, ...state.recents.filter(r => r !== id)].slice(0, MAX_RECENTS) });
    if (state.remote) recordPromptUsageOnServer(id).catch(() => {});
    else recordLocalPromptUsage(id);
  }, []);

  const isFavorite = useCallback(id => current.favorites.includes(id), [current.favorites]);

  return {
    favorites: current.favorites,
    recents: current.recents,
    loaded: current.loaded,
    isFavorite,
    toggleFavorite,
    recordUsage
  };
}
