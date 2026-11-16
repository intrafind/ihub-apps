// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { renderHook, act, cleanup } from '@testing-library/react';

import useDarkMode from '../../../client/src/hooks/useDarkMode';
import {
  getThemeSnapshot,
  setThemePreference,
  subscribeTheme
} from '../../../client/src/utils/themePreference';

/**
 * Every `useDarkMode()` caller shares one theme store (SH-B9 / ID-B8 / OB-B17 / PL-B19).
 *
 * Before the store, each caller kept its own copy of the preference and its own system-theme
 * listener: the admin layout's bare `useDarkMode()` stayed on `auto` after the user picked
 * "Dark" in a toggle, and switched the page back to light when the OS theme changed.
 */

/** A controllable `prefers-color-scheme: dark` media query. */
function installSystemTheme(initiallyDark) {
  const listeners = new Set();
  const query = {
    matches: initiallyDark,
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn)
  };
  window.matchMedia = () => query;
  return {
    listenerCount: () => listeners.size,
    change(dark) {
      query.matches = dark;
      listeners.forEach(fn => fn({ matches: dark }));
    }
  };
}

const html = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  html().removeAttribute('data-theme');
  html().classList.remove('dark');
});

afterEach(() => {
  cleanup();
  delete window.matchMedia;
});

describe('shared theme store', () => {
  test('two callers agree when one of them changes the preference', () => {
    installSystemTheme(false);
    const toggle = renderHook(() => useDarkMode());
    const layout = renderHook(() => useDarkMode());

    act(() => toggle.result.current.enableDark());

    expect(toggle.result.current.preference).toBe('dark');
    expect(layout.result.current.preference).toBe('dark');
    expect(layout.result.current.isDark).toBe(true);
    expect(html().getAttribute('data-theme')).toBe('dark');
  });

  test('an explicit choice survives an OS theme change', () => {
    const system = installSystemTheme(false);
    // The admin layout mounts first and stays on the default `auto`.
    const layout = renderHook(() => useDarkMode());
    const toggle = renderHook(() => useDarkMode());

    act(() => toggle.result.current.setPreference('dark'));
    act(() => system.change(false));

    expect(layout.result.current.isDark).toBe(true);
    expect(toggle.result.current.isDark).toBe(true);
    expect(html().getAttribute('data-theme')).toBe('dark');
  });

  test('auto follows the OS for every caller', () => {
    const system = installSystemTheme(false);
    const first = renderHook(() => useDarkMode());
    const second = renderHook(() => useDarkMode());
    expect(first.result.current.isDark).toBe(false);

    act(() => system.change(true));

    expect(first.result.current.isDark).toBe(true);
    expect(second.result.current.isDark).toBe(true);
    expect(html().getAttribute('data-theme')).toBe('dark');
  });

  test('toggleMode cycles auto, light, dark from the shared state', () => {
    installSystemTheme(false);
    const first = renderHook(() => useDarkMode());
    const second = renderHook(() => useDarkMode());

    act(() => first.result.current.toggleMode());
    expect(second.result.current.preference).toBe('light');
    act(() => second.result.current.toggleMode());
    expect(first.result.current.preference).toBe('dark');
    act(() => first.result.current.toggleMode());
    expect(second.result.current.preference).toBe('auto');
  });

  test('one system-theme listener, however many callers', () => {
    const system = installSystemTheme(false);
    const callers = [1, 2, 3].map(() => renderHook(() => useDarkMode()));
    expect(system.listenerCount()).toBe(1);

    callers.forEach(caller => caller.unmount());
    expect(system.listenerCount()).toBe(0);
  });

  test('picks up a preference stored while nobody was subscribed', () => {
    installSystemTheme(false);
    localStorage.setItem('ih-dark-mode', 'dark');
    const { result } = renderHook(() => useDarkMode());
    expect(result.current.preference).toBe('dark');
    expect(result.current.isDark).toBe(true);
  });

  test('the snapshot keeps its identity until something changes', () => {
    installSystemTheme(false);
    const unsubscribe = subscribeTheme(() => {});
    const before = getThemeSnapshot();
    expect(getThemeSnapshot()).toBe(before);

    setThemePreference('light');
    const after = getThemeSnapshot();
    expect(after).not.toBe(before);
    expect(after).toEqual({ preference: 'light', isDark: false });
    unsubscribe();
  });

  test('an invalid preference changes nothing', () => {
    installSystemTheme(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useDarkMode());
    act(() => result.current.setPreference('blue'));
    expect(result.current.preference).toBe('auto');
    expect(localStorage.getItem('ih-dark-mode')).toBeNull();
    warn.mockRestore();
  });
});
