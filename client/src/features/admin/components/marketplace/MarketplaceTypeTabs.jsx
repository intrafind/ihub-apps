import { useTranslation } from 'react-i18next';

/** All supported marketplace item types in display order */
const TYPES = ['all', 'app', 'model', 'prompt', 'skill', 'workflow'];

/**
 * Horizontal tab bar for filtering marketplace items by type.
 *
 * Shows a count badge next to each type label when item counts are available.
 * The active tab is highlighted with a blue border and text color.
 *
 * @param {Object} props
 * @param {string} props.activeType - Currently selected type key ('all', 'app', etc.)
 * @param {Function} props.onChange - Called with the new type key when a tab is clicked
 * @param {Object} [props.counts] - Map of type key to item count for badge display
 *
 * @example
 * <MarketplaceTypeTabs
 *   activeType="app"
 *   onChange={setActiveType}
 *   counts={{ all: 42, app: 10, model: 5, prompt: 12, skill: 8, workflow: 7 }}
 * />
 */
const MarketplaceTypeTabs = ({ activeType, onChange, counts = {} }) => {
  const { t } = useTranslation();

  return (
    <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
      {TYPES.map(type => {
        const count = counts[type] || 0;
        const isActive = activeType === type;

        // Pluralize type label for non-'all' tabs (e.g. "Apps", "Models")
        const label =
          type === 'all'
            ? t('admin.marketplace.types.all', 'All')
            : t(
                `admin.marketplace.types.${type}s`,
                type.charAt(0).toUpperCase() + type.slice(1) + 's'
              );

        return (
          <button
            key={type}
            onClick={() => onChange(type)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              isActive
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
            aria-current={isActive ? 'page' : undefined}
          >
            {label}
            {count > 0 && (
              <span
                className={`px-1.5 py-0.5 rounded-full text-xs ${
                  isActive
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default MarketplaceTypeTabs;
