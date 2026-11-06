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
 */

import { useState, useEffect, useCallback } from 'react';
import {
  VALID_MODES,
  applyThemeToDocument,
  getStoredPreference,
  resolveIsDark,
  storePreference
} from '../utils/themePreference';

/**
 * Custom hook for managing dark mode
 * @returns {Object} Dark mode state and controls
 */
const useDarkMode = () => {
  const [preference, setPreferenceState] = useState(() => getStoredPreference());
  const [isDark, setIsDark] = useState(() => resolveIsDark(getStoredPreference()));

  // Update preference and persist it (localStorage, or the tab's sessionStorage in embed mode)
  const setPreference = useCallback(newPreference => {
    if (!VALID_MODES.has(newPreference)) {
      console.warn(`Invalid dark mode preference: ${newPreference}`);
      return;
    }

    storePreference(newPreference);

    setPreferenceState(newPreference);
    const dark = resolveIsDark(newPreference);
    setIsDark(dark);
    applyThemeToDocument(dark);
  }, []);

  // Cycle through modes: auto -> light -> dark -> auto
  const toggleMode = useCallback(() => {
    const nextMode = {
      auto: 'light',
      light: 'dark',
      dark: 'auto'
    };
    setPreference(nextMode[preference] || 'auto');
  }, [preference, setPreference]);

  // Apply initial dark mode on mount
  useEffect(() => {
    applyThemeToDocument(isDark);
  }, [isDark]);

  // Listen for system preference changes when in 'auto' mode
  useEffect(() => {
    if (preference !== 'auto') return;
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mediaQuery) return;

    const handleChange = event => {
      const dark = event.matches;
      setIsDark(dark);
      applyThemeToDocument(dark);
    };

    // Use addEventListener (modern browsers: Chrome 85+, Safari 14+, Firefox 78+)
    // Fallback to addListener for older browsers (deprecated but necessary for Safari < 14)
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    } else if (mediaQuery.addListener) {
      // Deprecated fallback for older Safari (< 14)
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, [preference]);

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
