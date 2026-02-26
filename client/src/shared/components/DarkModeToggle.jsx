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

const DarkModeToggle = ({ className = '' }) => {
  const { t } = useTranslation();
  const { preference, isDark, toggleMode } = useDarkMode();

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
          icon: isDark ? 'moon' : 'sun',
          label: t('darkMode.auto', 'Auto (system)'),
          nextLabel: t('darkMode.switchToLight', 'Switch to light mode')
        };
    }
  };

  const { icon, label, nextLabel } = getIconAndLabel();

  return (
    <button
      onClick={toggleMode}
      className={`p-2 rounded-md hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20 transition-colors ${className}`}
      aria-label={nextLabel}
      title={`${label} - ${nextLabel}`}
    >
      <Icon name={icon} size="md" className="text-current" aria-hidden="true" />
      {preference === 'auto' && (
        <span className="sr-only">
          {t('darkMode.followingSystem', 'Following system preference')}
        </span>
      )}
    </button>
  );
};

export default DarkModeToggle;
