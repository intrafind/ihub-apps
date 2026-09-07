import { renderHook, act } from '@testing-library/react';

import { createFavoriteItemHelpers } from '../../../client/src/utils/favoriteItems';
import useFavorites from '../../../client/src/shared/hooks/useFavorites';
import { canAccessLink, FEATURE_ROUTES } from '../../../client/src/utils/pageAccess';
import {
  getIntegrationSettings,
  updateSettingsFromUrl
} from '../../../client/src/utils/integrationSettings';
import {
  setPendingChatStart,
  consumePendingChatStart
} from '../../../client/src/features/chat/startChatHandoff';

/**
 * The start page, the sidebar and the apps browser all share one favorites
 * list (localStorage key `ihub_favorite_apps`) and must stay in sync without a
 * reload; the sidebar/header choice is driven by integration settings that
 * older browsers persisted before `showSidebar` existed. These tests pin those
 * contracts.
 */

const KEY = 'ihub_favorite_apps';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('favoriteItems', () => {
  test('starts empty and toggles ids in and out', () => {
    const fav = createFavoriteItemHelpers(KEY);
    expect(fav.getFavorites()).toEqual([]);

    expect(fav.toggleFavorite('chat')).toBe(true);
    expect(fav.isFavorite('chat')).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY))).toEqual(['chat']);

    expect(fav.toggleFavorite('chat')).toBe(false);
    expect(fav.getFavorites()).toEqual([]);
  });

  test('announces changes to other components with the storage key', () => {
    const fav = createFavoriteItemHelpers(KEY);
    const seen = [];
    const onChange = e => seen.push(e.detail);
    window.addEventListener('ihub:favorites-changed', onChange);
    try {
      fav.toggleFavorite('summarizer');
    } finally {
      window.removeEventListener('ihub:favorites-changed', onChange);
    }
    expect(seen).toEqual([{ storageKey: KEY, favorites: ['summarizer'] }]);
  });

  test('a corrupted value is treated as no favorites', () => {
    localStorage.setItem(KEY, '{not json');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(createFavoriteItemHelpers(KEY).getFavorites()).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('useFavorites', () => {
  test('reads the stored list and updates synchronously on toggle', () => {
    localStorage.setItem(KEY, JSON.stringify(['chat']));
    const { result } = renderHook(() => useFavorites(KEY));

    expect(result.current.favorites).toEqual(['chat']);
    expect(result.current.isFavorite('chat')).toBe(true);

    act(() => {
      result.current.toggleFavorite('translator');
    });
    expect(result.current.favorites).toEqual(['chat', 'translator']);
    expect(result.current.isFavorite('translator')).toBe(true);
  });

  test('two components on the same key stay in sync; other keys are ignored', () => {
    const sidebar = renderHook(() => useFavorites(KEY));
    const startPage = renderHook(() => useFavorites(KEY));
    const prompts = renderHook(() => useFavorites('ihub_favorite_prompts'));

    act(() => {
      sidebar.result.current.toggleFavorite('chat');
    });

    expect(startPage.result.current.favorites).toEqual(['chat']);
    expect(prompts.result.current.favorites).toEqual([]);
  });

  test('picks up changes made in another tab via the storage event', () => {
    const { result } = renderHook(() => useFavorites(KEY));
    expect(result.current.favorites).toEqual([]);

    act(() => {
      localStorage.setItem(KEY, JSON.stringify(['email']));
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    });
    expect(result.current.favorites).toEqual(['email']);

    // A storage event for an unrelated key must not clobber state.
    act(() => {
      localStorage.setItem(KEY, JSON.stringify(['ignored']));
      window.dispatchEvent(new StorageEvent('storage', { key: 'something_else' }));
    });
    expect(result.current.favorites).toEqual(['email']);
  });
});

describe('pageAccess.canAccessLink', () => {
  const uiConfig = {
    pages: {
      faq: {},
      internal: { authRequired: true },
      hr: { allowedGroups: ['hr', 'admins'] },
      everyone: { allowedGroups: ['*'] },
      unrestricted: { allowedGroups: [] }
    }
  };

  test('non-page links and unknown pages are always visible', () => {
    expect(canAccessLink({ url: '/prompts' }, { uiConfig })).toBe(true);
    expect(canAccessLink({ url: 'https://example.com' }, { uiConfig })).toBe(true);
    expect(canAccessLink({ url: '/pages/missing' }, { uiConfig })).toBe(true);
    expect(canAccessLink({ url: '/pages/faq' }, { uiConfig: {} })).toBe(true);
    expect(canAccessLink(null, { uiConfig })).toBe(true);
  });

  test('authRequired hides the link from anonymous users only', () => {
    expect(canAccessLink({ url: '/pages/internal' }, { uiConfig, isAuthenticated: false })).toBe(
      false
    );
    expect(canAccessLink({ url: '/pages/internal' }, { uiConfig, isAuthenticated: true })).toBe(
      true
    );
  });

  test('allowedGroups requires a matching group unless it is "*" or empty', () => {
    const ctx = groups => ({ uiConfig, isAuthenticated: true, user: { groups } });
    expect(canAccessLink({ url: '/pages/hr' }, ctx(['users']))).toBe(false);
    expect(canAccessLink({ url: '/pages/hr' }, ctx(['hr']))).toBe(true);
    expect(canAccessLink({ url: '/pages/hr' }, ctx(undefined))).toBe(false);
    expect(canAccessLink({ url: '/pages/everyone' }, ctx(['users']))).toBe(true);
    expect(canAccessLink({ url: '/pages/unrestricted' }, ctx(['users']))).toBe(true);
  });

  test('feature-gated routes are declared for the sidebar and the footer', () => {
    expect(FEATURE_ROUTES['/prompts']).toBe('promptsLibrary');
    expect(FEATURE_ROUTES['/workflows']).toBe('workflows');
  });
});

describe('integrationSettings', () => {
  test('defaults show header, footer and sidebar', () => {
    expect(getIntegrationSettings()).toEqual({
      showHeader: true,
      showFooter: true,
      showSidebar: true,
      language: null
    });
  });

  test('settings persisted before showSidebar existed default it to enabled', () => {
    localStorage.setItem(
      'ihubIntegrationSettings',
      JSON.stringify({ showHeader: true, showFooter: false, language: 'de' })
    );
    expect(getIntegrationSettings()).toMatchObject({ showFooter: false, showSidebar: true });
  });

  test('?sidebar=false switches to the classic header and is remembered; ?sidebar=true resets', () => {
    const off = updateSettingsFromUrl(new URLSearchParams('sidebar=false'));
    expect(off.showSidebar).toBe(false);
    expect(off.showHeader).toBe(true);
    expect(JSON.parse(localStorage.getItem('ihubIntegrationSettings')).showSidebar).toBe(false);

    // A later visit without the parameter keeps the choice.
    expect(updateSettingsFromUrl(new URLSearchParams('')).showSidebar).toBe(false);

    expect(updateSettingsFromUrl(new URLSearchParams('sidebar=true')).showSidebar).toBe(true);
  });

  test('embed mode renders without chrome and never writes to localStorage', () => {
    sessionStorage.setItem('ihubEmbedMode', '1');
    expect(getIntegrationSettings()).toEqual({
      showHeader: false,
      showFooter: false,
      showSidebar: false,
      language: null
    });
    // URL parameters still apply to the current render, but nothing is
    // persisted — the embed must not pollute the direct-visit preferences.
    updateSettingsFromUrl(new URLSearchParams('sidebar=true&header=true'));
    expect(localStorage.getItem('ihubIntegrationSettings')).toBeNull();
  });
});

describe('startChatHandoff', () => {
  test('is consumed once, and only by the app it was stored for', () => {
    const files = { name: 'notes.pdf' };
    setPendingChatStart({ appId: 'chat', files });

    expect(consumePendingChatStart('translator')).toBeNull();
    expect(consumePendingChatStart('chat')).toEqual({ appId: 'chat', files });
    expect(consumePendingChatStart('chat')).toBeNull();
  });
});
