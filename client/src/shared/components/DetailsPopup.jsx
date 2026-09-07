import Icon from './Icon';

/**
 * Standard header shell shared by the App/Prompt/Model/ShortLink details
 * popups: icon tile, title, subtitle (usually the resource id) and a close
 * button. Pass `iconStyle` (e.g. `{ backgroundColor: app.color }`) for
 * popups that color the tile per-resource instead of a fixed Tailwind class.
 */
export function DetailsPopupHeader({
  icon,
  iconClassName = 'bg-indigo-100 dark:bg-indigo-900/50',
  iconColorClassName = 'text-indigo-600 dark:text-indigo-400',
  iconStyle,
  title,
  subtitle,
  onClose
}) {
  return (
    <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-center justify-between rounded-t-lg">
      <div className="flex items-center space-x-3">
        <div
          className={`w-12 h-12 rounded-lg flex items-center justify-center ${
            iconStyle ? 'text-white font-bold' : iconClassName
          }`}
          style={iconStyle}
        >
          <Icon name={icon} className={`w-6 h-6 ${iconStyle ? '' : iconColorClassName}`} />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
        </div>
      </div>
      <button
        onClick={onClose}
        className="p-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        <Icon name="x" className="w-5 h-5" />
      </button>
    </div>
  );
}

/** Standard sticky footer shell; pass the action buttons as children. */
export function DetailsPopupFooter({ children }) {
  return (
    <div className="sticky bottom-0 bg-gray-50 dark:bg-gray-700 border-t border-gray-200 dark:border-gray-600 px-6 py-4 flex justify-between items-center rounded-b-lg">
      {children}
    </div>
  );
}
