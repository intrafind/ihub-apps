import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import StreamingMarkdown from '../../../chat/components/StreamingMarkdown';
import {
  fetchMarketplaceItemDetail,
  installMarketplaceItem,
  updateMarketplaceItem,
  uninstallMarketplaceItem,
  detachMarketplaceItem
} from '../../../../api/adminApi';

/**
 * Flatten a potentially nested YAML frontmatter object to dot-path key/value pairs.
 * E.g. { metadata: { author: "foo" } } → [["metadata.author", "foo"]]
 *
 * @param {object} obj - Frontmatter object
 * @param {string} [prefix=''] - Key prefix for nested objects
 * @returns {Array<[string, string]>} Flat [key, value] pairs
 */
function flattenFrontmatter(obj, prefix = '') {
  const result = [];
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      result.push(...flattenFrontmatter(val, fullKey));
    } else if (Array.isArray(val)) {
      result.push([fullKey, val.join(', ')]);
    } else {
      result.push([fullKey, String(val)]);
    }
  }
  return result;
}

/**
 * Color classes for each item type badge.
 * Matches the type colors used in MarketplaceItemCard for visual consistency.
 */
const TYPE_COLORS = {
  app: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  model: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  prompt: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  skill: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  workflow: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300'
};

/**
 * Slide-in detail panel for a single marketplace item.
 *
 * Opens as a right-side drawer over the browse grid. Fetches full item detail
 * from the server on mount. Supports install, update, uninstall, and detach
 * actions. Destructive actions (uninstall, detach) require a confirmation step.
 *
 * Tabs:
 * - Overview: description, tags, and metadata (registry, category, license, install date)
 * - Configuration: raw JSON preview of the item's content
 *
 * @param {Object} props
 * @param {Object} props.item - Initial item data from the browse grid (used as fallback)
 * @param {Function} props.onClose - Called when the panel should be dismissed
 * @param {Function} [props.onAction] - Called after any install/update/uninstall/detach action
 */
const MarketplaceItemDetail = ({ item: initialItem, onClose, onAction }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [item, setItem] = useState(initialItem);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [confirmAction, setConfirmAction] = useState(null);

  // Resolve localized text for the current language
  const lang = i18n.language?.split('-')[0] || 'en';
  const displayName = item?.displayName?.[lang] || item?.displayName?.en || item?.name;
  const description = item?.description?.[lang] || item?.description?.en || '';
  const isInstalled = item?.installationStatus === 'installed';

  /**
   * Fetches full item detail from server when the panel opens.
   * Falls back to the initial item data if the request fails.
   * Using the full initialItem object as dependency ensures re-fetch when
   * the parent forces a refresh by creating a new object reference.
   */
  useEffect(() => {
    if (!initialItem) return;
    setLoading(true);
    fetchMarketplaceItemDetail(initialItem.registryId, initialItem.type, initialItem.name)
      .then(data => {
        setItem(data);
      })
      .catch(() => {
        setItem(initialItem);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialItem?.registryId, initialItem?.type, initialItem?.name]);

  /**
   * Executes an item action (install, update, uninstall, or detach),
   * then refreshes the item detail and notifies the parent.
   *
   * @param {string} action - One of: install, update, uninstall, detach
   */
  const handleAction = async action => {
    setActionLoading(action);
    try {
      if (action === 'install') {
        await installMarketplaceItem(item.registryId, item.type, item.name);
      } else if (action === 'update') {
        await updateMarketplaceItem(item.registryId, item.type, item.name);
      } else if (action === 'uninstall') {
        await uninstallMarketplaceItem(item.registryId, item.type, item.name);
      } else if (action === 'detach') {
        await detachMarketplaceItem(item.registryId, item.type, item.name);
      }

      // Refresh the item to reflect the new installation status
      const updated = await fetchMarketplaceItemDetail(item.registryId, item.type, item.name);
      setItem(updated);
      onAction?.();
      setConfirmAction(null);
    } catch (err) {
      alert(err.message || `${action} failed`);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Transparent backdrop - clicking it closes the panel */}
      <div className="flex-1 bg-black/40" onClick={onClose} />

      {/* Detail panel */}
      <div className="w-full max-w-2xl bg-white dark:bg-gray-800 shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <div className="flex-1 min-w-0 mr-4">
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  TYPE_COLORS[item?.type] || 'bg-gray-100 text-gray-800'
                }`}
              >
                {t(`admin.marketplace.types.${item?.type}`, item?.type)}
              </span>
              {item?.version && (
                <span className="text-xs text-gray-400 dark:text-gray-500">v{item.version}</span>
              )}
              {isInstalled && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                  &#x2713; {t('admin.marketplace.installed', 'Installed')}
                </span>
              )}
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">{displayName}</h2>
            {item?.author && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">by {item.author}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl font-bold"
            aria-label={t('common.close', 'Close')}
          >
            &#x2715;
          </button>
        </div>

        {/* Action buttons bar */}
        <div className="flex gap-2 px-6 py-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
          {!isInstalled && (
            <button
              onClick={() => handleAction('install')}
              disabled={actionLoading === 'install'}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              {actionLoading === 'install' ? '...' : t('admin.marketplace.install', 'Install')}
            </button>
          )}
          {isInstalled && (
            <>
              {item?.type === 'skill' && (
                <button
                  onClick={() => {
                    onClose();
                    navigate(`/admin/skills/${item.name}`);
                  }}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
                >
                  {t('admin.marketplace.viewSkill', 'View Skill')}
                </button>
              )}
              <button
                onClick={() => setConfirmAction('uninstall')}
                disabled={!!actionLoading}
                className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 text-sm font-medium"
              >
                {t('admin.marketplace.uninstall', 'Uninstall')}
              </button>
              <button
                onClick={() => setConfirmAction('detach')}
                disabled={!!actionLoading}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 text-sm font-medium"
              >
                {t('admin.marketplace.detach', 'Detach')}
              </button>
            </>
          )}
        </div>

        {/* Destructive action confirmation inline panel */}
        {confirmAction && (
          <div className="mx-6 my-3 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-3">
              {confirmAction === 'uninstall'
                ? t(
                    'admin.marketplace.confirmUninstall',
                    `Are you sure you want to uninstall "${displayName}"? This will delete the files.`
                  )
                : t(
                    'admin.marketplace.confirmDetach',
                    `Detach "${displayName}" from marketplace tracking? Files will be kept.`
                  )}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => handleAction(confirmAction)}
                disabled={!!actionLoading}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm disabled:opacity-50"
              >
                {actionLoading === confirmAction ? '...' : t('common.confirm', 'Confirm')}
              </button>
              <button
                onClick={() => setConfirmAction(null)}
                className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded text-sm"
              >
                {t('common.cancel', 'Cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Tab navigation */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 px-6">
          {['overview', 'content'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-3 px-4 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
              aria-current={activeTab === tab ? 'page' : undefined}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab content area */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
            </div>
          )}

          {/* Overview tab */}
          {!loading && activeTab === 'overview' && (
            <div className="p-6 space-y-6">
              {description && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.marketplace.detail.description', 'Description')}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-400 text-sm leading-relaxed">
                    {description}
                  </p>
                </div>
              )}

              {item?.tags && item.tags.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.marketplace.detail.tags', 'Tags')}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {item.tags.map(tag => (
                      <span
                        key={tag}
                        className="px-2.5 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full text-sm"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Metadata table */}
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
                {item?.source?.url && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('admin.marketplace.detail.source', 'Source')}
                    </span>
                    <a
                      href={item.source.url
                        .replace(
                          /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
                          'https://github.com/$1/$2/blob/$3/$4'
                        )
                        .replace(/\/refs\/heads\/([^/]+)\//, '/$1/')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 dark:text-blue-400 hover:underline truncate max-w-xs"
                    >
                      GitHub
                    </a>
                  </div>
                )}
                {item?.registryName && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('admin.marketplace.detail.registry', 'Registry')}
                    </span>
                    <span className="text-gray-900 dark:text-white">{item.registryName}</span>
                  </div>
                )}
                {item?.category && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('admin.marketplace.detail.category', 'Category')}
                    </span>
                    <span className="text-gray-900 dark:text-white">{item.category}</span>
                  </div>
                )}
                {item?.license && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('admin.marketplace.detail.license', 'License')}
                    </span>
                    <span className="text-gray-900 dark:text-white">{item.license}</span>
                  </div>
                )}
                {item?.installation && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500 dark:text-gray-400">
                      {t('admin.marketplace.detail.installedAt', 'Installed')}
                    </span>
                    <span className="text-gray-900 dark:text-white">
                      {new Date(item.installation.installedAt).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Content tab - markdown or JSON preview of item content */}
          {!loading && activeTab === 'content' && (
            <div className="p-6">
              {item?.contentPreview ? (
                item.contentPreview.body !== undefined ? (
                  // Structured skill preview: frontmatter metadata table + markdown body
                  <div className="space-y-4">
                    {item.contentPreview.frontmatter &&
                      Object.keys(item.contentPreview.frontmatter).length > 0 && (
                        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-2">
                          {flattenFrontmatter(item.contentPreview.frontmatter).map(([key, val]) => (
                            <div key={key} className="flex justify-between text-sm gap-4">
                              <span className="text-gray-500 dark:text-gray-400 shrink-0">{key}</span>
                              <span className="text-gray-900 dark:text-white text-right">{val}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    <div className="prose dark:prose-invert max-w-none text-sm">
                      <StreamingMarkdown content={item.contentPreview.body} />
                    </div>
                  </div>
                ) : typeof item.contentPreview === 'string' ? (
                  <div className="prose dark:prose-invert max-w-none text-sm">
                    <StreamingMarkdown content={item.contentPreview} />
                  </div>
                ) : (
                  <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-4 rounded-lg overflow-x-auto text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 whitespace-pre-wrap">
                    {JSON.stringify(item.contentPreview, null, 2)}
                  </pre>
                )
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.marketplace.detail.noPreview', 'No content preview available.')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MarketplaceItemDetail;
