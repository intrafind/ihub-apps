/**
 * DarkModeToggle Component
 *
 * A button that toggles between dark mode, light mode, and auto (system preference).
 * Displays:
 * - Sun icon for light mode
 * - Moon icon for dark mode
 * - Computer icon for auto mode
 */

import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import useDarkMode from '../../hooks/useDarkMode';

function DarkModeToggle({ className = '', variant = 'header' }) {
  const { t } = useTranslation();
  const { preference, toggleMode } = useDarkMode();

  // Get the icon and label based on current preference
  const getIconAndLabel = () => {
    switch (preference) {
      case 'light':
        return {
          icon: 'sun',
          label: t('darkMode.light', 'Light mode'),
          nextLabel: t('darkMode.switchToDark', 'Switch to dark mode')
        };
      case 'dark':
        return {
          icon: 'moon',
          label: t('darkMode.dark', 'Dark mode'),
          nextLabel: t('darkMode.switchToAuto', 'Switch to auto mode')
        };
      case 'auto':
      default:
        return {
          icon: 'computer-desktop',
          label: t('darkMode.auto', 'Auto (system)'),
          nextLabel: t('darkMode.switchToLight', 'Switch to light mode')
        };
    }
  };

  const { icon, label, nextLabel } = getIconAndLabel();

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
