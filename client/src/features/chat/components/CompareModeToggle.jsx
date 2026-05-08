import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Toggle switch for enabling/disabling compare mode
 * @param {Object} props
 * @param {boolean} props.enabled - Whether compare mode is currently enabled
 * @param {Function} props.onChange - Callback when toggle is changed
 * @param {boolean} props.disabled - Whether the toggle is disabled
 */
function CompareModeToggle({ enabled, onChange, disabled = false }) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => !disabled && onChange(!enabled)}
        disabled={disabled}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
          enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        title={t('chat.compareMode.tooltip')}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('chat.compareMode.toggle')}
      </span>
      {enabled && (
        <Icon
          name="check-circle"
          size="sm"
          className="text-green-500"
          title={t('chat.compareMode.enabled')}
        />
      )}
    </div>
  );
}

export default CompareModeToggle;
