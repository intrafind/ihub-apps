// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * DarkModeToggle Component
 *
 * A button that toggles between dark mode, light mode, and auto (system preference).
 * Displays:
 * - Sun icon for light mode
 * - Moon icon for dark mode
 * - Computer icon for auto mode
 *
 * Variants:
 * - `header` (default): icon only, on the coloured top bar.
 * - `sidebar`: icon only, on a white/dark surface next to the language selector.
 * - `admin`: icon plus a visible "Theme: …" label, for the admin sidebar footer. With
 *   `collapsed`, only the icon shows and the label becomes the accessible name.
 *
 * Every instance reads the shared theme store (`useDarkMode`), so toggles on different parts
 * of the page always agree.
 */

import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import useDarkMode from '../../hooks/useDarkMode';

/**
 * @param {Object} props
 * @param {string} [props.className] - Extra classes for the button.
 * @param {'header'|'sidebar'|'admin'} [props.variant] - Where the toggle sits (see above).
 * @param {boolean} [props.collapsed] - `admin` variant only: icon only, for a collapsed sidebar.
 */
function DarkModeToggle({ className = '', variant = 'header', collapsed = false }) {
  const { t } = useTranslation();
  const { preference, toggleMode } = useDarkMode();

  // Get the icon and label based on current preference
  const getIconAndLabel = () => {
    switch (preference) {
      case 'light':
        return {
          icon: 'sun',
          label: t('darkMode.light', 'Light mode'),
          themeLabel: t('darkMode.themeLight', 'Theme: Light'),
          nextLabel: t('darkMode.switchToDark', 'Switch to dark mode')
        };
      case 'dark':
        return {
          icon: 'moon',
          label: t('darkMode.dark', 'Dark mode'),
          themeLabel: t('darkMode.themeDark', 'Theme: Dark'),
          nextLabel: t('darkMode.switchToAuto', 'Switch to auto mode')
        };
      case 'auto':
      default:
        return {
          icon: 'computer-desktop',
          label: t('darkMode.auto', 'Auto (system)'),
          themeLabel: t('darkMode.themeAuto', 'Theme: Auto (follows system)'),
          nextLabel: t('darkMode.switchToLight', 'Switch to light mode')
        };
    }
  };

  const { icon, label, themeLabel, nextLabel } = getIconAndLabel();

  if (variant === 'admin') {
    // The visible text names the button (WCAG 2.5.3); the tooltip says what a click does.
    return (
      <button
        type="button"
        onClick={toggleMode}
        aria-label={collapsed ? themeLabel : undefined}
        title={nextLabel}
        className={`flex items-center gap-2.5 min-h-[36px] rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark ${
          collapsed ? 'justify-center h-9 w-9 mx-auto' : 'w-full px-3 py-2'
        } ${className}`}
      >
        <Icon name={icon} size="sm" className="shrink-0 text-current" aria-hidden="true" />
        {!collapsed && <span className="truncate">{themeLabel}</span>}
      </button>
    );
  }

  // The header variant sits on the coloured top bar; the sidebar variant sits
  // on a white/dark surface next to the compact language selector.
  const variantClasses =
    variant === 'sidebar'
      ? 'p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-hidden focus:ring-1 focus:ring-indigo-400'
      : 'px-2 py-1.5 rounded-sm border border-white/50 hover:bg-white/10 focus:outline-hidden focus:ring-1 focus:ring-white text-sm';

  return (
    <button
      onClick={toggleMode}
      className={`flex items-center justify-center transition-colors ${variantClasses} ${className}`}
      aria-label={nextLabel}
      title={`${label} - ${nextLabel}`}
    >
      <Icon name={icon} size="sm" className="text-current" aria-hidden="true" />
      {preference === 'auto' && (
        <span className="sr-only">
          {t('darkMode.followingSystem', 'Following system preference')}
        </span>
      )}
    </button>
  );
}

export default DarkModeToggle;
