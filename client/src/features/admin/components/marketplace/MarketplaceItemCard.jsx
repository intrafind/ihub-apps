import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { installMarketplaceItem } from '../../../../api/adminApi';

/**
 * Color classes for each item type badge, applying both light and dark mode variants.
 * Uses Tailwind utility classes matching the project's design system.
 */
const TYPE_COLORS = {
  app: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  model: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  prompt: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  skill: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  workflow: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300'
};

/**
 * Card component representing a single marketplace item in the browse grid.
 *
 * Displays item metadata including type badge, name, description, tags, author,
 * version, and installation status. Provides a quick install button that triggers
 * installation without opening the detail panel.
 *
 * Clicking the card body opens the detail panel via the `onClick` callback.
 *
 * @param {Object} props
 * @param {Object} props.item - The marketplace item data object
 * @param {string} props.item.registryId - Registry this item belongs to
 * @param {string} props.item.type - Item type: app, model, prompt, skill, or workflow
 * @param {string} props.item.name - Unique item identifier within the registry
 * @param {Object} [props.item.displayName] - Localized display names keyed by language code
 * @param {Object} [props.item.description] - Localized descriptions keyed by language code
 * @param {string} [props.item.version] - Semantic version string
 * @param {string[]} [props.item.tags] - Array of tag strings for filtering
 * @param {string} [props.item.author] - Author name or organization
 * @param {string} [props.item.registryName] - Display name of the source registry
 * @param {string} [props.item.installationStatus] - One of: installed, update-available, or undefined
 * @param {Function} props.onClick - Called when the card body is clicked (open detail panel)
 * @param {Function} [props.onAction] - Called after a successful install to refresh the parent list
 */
const MarketplaceItemCard = ({ item, onClick, onAction }) => {
  const { t, i18n } = useTranslation();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState(null);

  // Resolve localized text, falling back to English then the raw identifier
  const lang = i18n.language?.split('-')[0] || 'en';
  const displayName = item.displayName?.[lang] || item.displayName?.en || item.name;
  const description = item.description?.[lang] || item.description?.en || '';
  const isInstalled = item.installationStatus === 'installed';
  const hasUpdate = item.installationStatus === 'update-available';

  /**
   * Installs the item without navigating away from the browse grid.
   * Stops event propagation so the card click handler does not also fire.
   *
   * @param {React.MouseEvent} e - The button click event
   */
  const handleInstall = async e => {
    e.stopPropagation();
    if (isInstalled) return;
    setInstalling(true);
    setError(null);
    try {
      await installMarketplaceItem(item.registryId, item.type, item.name);
      onAction?.();
    } catch (err) {
      setError(err.message || 'Install failed');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      onClick={onClick}
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:shadow-md cursor-pointer transition-all hover:border-blue-300 dark:hover:border-blue-600"
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick?.()}
    >
      {/* Type badge and version */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              TYPE_COLORS[item.type] || 'bg-gray-100 text-gray-800'
            }`}
          >
            {t(`admin.marketplace.types.${item.type}`, item.type)}
          </span>
          {isInstalled && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
              &#x2713; {t('admin.marketplace.installed', 'Installed')}
            </span>
          )}
        </div>
        {item.version && (
          <span className="text-xs text-gray-400 dark:text-gray-500">v{item.version}</span>
        )}
      </div>

      {/* Item name and description */}
      <h3 className="font-semibold text-gray-900 dark:text-white mb-1 line-clamp-1">
        {displayName}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-2 mb-3 min-h-[2.5rem]">
        {description}
      </p>

      {/* Tags (up to 3 shown) */}
      {item.tags && item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {item.tags.slice(0, 3).map(tag => (
            <span
              key={tag}
              className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded text-xs"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer: author/registry and install button */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400 dark:text-gray-500 truncate">
          {item.author ? `by ${item.author}` : item.registryName}
        </span>

        <button
          onClick={handleInstall}
          disabled={installing || isInstalled}
          className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
            isInstalled
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 cursor-default'
              : hasUpdate
                ? 'bg-orange-600 text-white hover:bg-orange-700'
                : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
          }`}
        >
          {installing
            ? '...'
            : isInstalled
              ? '\u2713 ' + t('admin.marketplace.installed', 'Installed')
              : hasUpdate
                ? t('admin.marketplace.update', 'Update')
                : t('admin.marketplace.install', 'Install')}
        </button>
      </div>

      {/* Inline error message */}
      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </div>
  );
};

export default MarketplaceItemCard;
