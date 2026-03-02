/**
 * useDarkMode Hook
 *
 * Provides dark mode toggle functionality with:
 * - localStorage persistence (key: ih-dark-mode)
 * - System preference detection (prefers-color-scheme: dark)
 * - Three modes: 'auto' (follow system), 'light', 'dark'
 * - Sets data-theme="dark" on <html> element for Tailwind compatibility
 */

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'ih-dark-mode';
const VALID_MODES = ['auto', 'light', 'dark'];

/**
 * Get the stored preference from localStorage
 * @returns {'auto'|'light'|'dark'} The stored preference or 'auto' as default
 */
const getStoredPreference = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_MODES.includes(stored)) {
      return stored;
    }
  } catch {
    // localStorage may be unavailable
  }
  return 'auto';
};

/**
 * Check if the system prefers dark mode
 * @returns {boolean} True if system prefers dark mode
 */
const getSystemPreference = () => {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

/**
 * Determine the effective dark mode state based on preference
 * @param {'auto'|'light'|'dark'} preference - User preference
 * @returns {boolean} Whether dark mode should be active
 */
const resolveIsDark = preference => {
  if (preference === 'dark') return true;
  if (preference === 'light') return false;
  // 'auto' - follow system preference
  return getSystemPreference();
};

/**
 * Custom hook for managing dark mode
 * @returns {Object} Dark mode state and controls
 */
const useDarkMode = () => {
  const [preference, setPreferenceState] = useState(() => getStoredPreference());
  const [isDark, setIsDark] = useState(() => resolveIsDark(getStoredPreference()));

  // Apply dark mode to document
  const applyDarkMode = useCallback(dark => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    if (dark) {
      html.setAttribute('data-theme', 'dark');
      html.classList.add('dark');
    } else {
      html.removeAttribute('data-theme');
      html.classList.remove('dark');
    }
  }, []);

  // Update preference and persist to localStorage
  const setPreference = useCallback(
    newPreference => {
      if (!VALID_MODES.includes(newPreference)) {
        console.warn(`Invalid dark mode preference: ${newPreference}`);
        return;
      }

      try {
        localStorage.setItem(STORAGE_KEY, newPreference);
      } catch {
        // localStorage may be unavailable
      }

      setPreferenceState(newPreference);
      const dark = resolveIsDark(newPreference);
      setIsDark(dark);
      applyDarkMode(dark);
    },
    [applyDarkMode]
  );

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
    applyDarkMode(isDark);
  }, [applyDarkMode, isDark]);

  // Listen for system preference changes when in 'auto' mode
  useEffect(() => {
    if (preference !== 'auto') return;
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mediaQuery) return;

    const handleChange = event => {
      const dark = event.matches;
      setIsDark(dark);
      applyDarkMode(dark);
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
  }, [preference, applyDarkMode]);

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
