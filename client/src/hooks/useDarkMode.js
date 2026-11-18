// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * useDarkMode Hook
 *
 * Provides dark mode toggle functionality with:
 * - localStorage persistence (key: ih-dark-mode); in embed mode the preference is kept in
 *   sessionStorage instead and localStorage is left alone (see utils/themePreference.js)
 * - System preference detection (prefers-color-scheme: dark)
 * - Three modes: 'auto' (follow system), 'light', 'dark'
 * - Sets data-theme="dark" on <html> element for Tailwind compatibility
 *
 * Every caller shares one store (`subscribeTheme` / `getThemeSnapshot` in themePreference.js),
 * so a choice made in one toggle is what every other caller sees, and only one system-theme
 * listener exists however many components use the hook.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  applyThemeToDocument,
  getThemeSnapshot,
  setThemePreference,
  subscribeTheme
} from '../utils/themePreference';

const NEXT_MODE = {
  auto: 'light',
  light: 'dark',
  dark: 'auto'
};

/**
 * Custom hook for managing dark mode
 * @returns {Object} Dark mode state and controls
 */
const useDarkMode = () => {
  const { preference, isDark } = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeSnapshot
  );

  // Update preference and persist it (localStorage, or the tab's sessionStorage in embed mode)
  const setPreference = useCallback(newPreference => {
    setThemePreference(newPreference);
  }, []);

  // Cycle through modes: auto -> light -> dark -> auto
  const toggleMode = useCallback(() => {
    setThemePreference(NEXT_MODE[getThemeSnapshot().preference] || 'auto');
  }, []);

  // Apply the current theme when a caller mounts (and whenever it changes), as before the store.
  useEffect(() => {
    applyThemeToDocument(isDark);
  }, [isDark]);

  return {
    /** Current preference: 'auto' | 'light' | 'dark' */
    preference,
    /** Whether dark mode is currently active */
    isDark,
    /** Set a specific preference */
    setPreference,
    /** Cycle to next mode (auto -> light -> dark -> auto) */
    toggleMode,
    /** Shorthand to enable dark mode */
    enableDark: () => setPreference('dark'),
    /** Shorthand to enable light mode */
    enableLight: () => setPreference('light'),
    /** Shorthand to enable auto mode (follow system) */
    enableAuto: () => setPreference('auto')
  };
};

export default useDarkMode;
