import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { browseMarketplace, fetchMarketplaceRegistries } from '../../../api/adminApi';
import MarketplaceItemCard from '../components/marketplace/MarketplaceItemCard';
import MarketplaceTypeTabs from '../components/marketplace/MarketplaceTypeTabs';
import MarketplaceItemDetail from '../components/marketplace/MarketplaceItemDetail';

/**
 * Main marketplace browse page for the admin panel.
 *
 * Fetches and displays items from all configured registries with filtering
 * by type (tabs), search text, registry, and installation status.
 * Clicking an item card opens a detail slide-in panel.
 *
 * When no registries are configured, shows an empty state with a call-to-action
 * to navigate to the registries management page.
 *
 * Architecture note: all API calls are isolated in named callbacks wrapped
 * in useCallback to allow stable dependency arrays and prevent infinite
 * render loops.
 */
const AdminMarketplacePage = () => {
  const { t } = useTranslation();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [registries, setRegistries] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);

  // Filter state
  const [activeType, setActiveType] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedRegistry, setSelectedRegistry] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);

  // Type badge counts derived from a full unfiltered fetch
  const [typeCounts, setTypeCounts] = useState({});

  /**
   * Loads the filtered item list for the current page.
   * Re-runs whenever any filter or pagination state changes.
   */
  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const result = await browseMarketplace({
        type: activeType !== 'all' ? activeType : undefined,
        search: search || undefined,
        registry: selectedRegistry || undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        page,
        limit: 24
      });
      setItems(result?.items || []);
      setTotal(result?.total || 0);
      setTotalPages(result?.totalPages || 1);
    } catch (err) {
      console.error('Error loading marketplace items:', err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [activeType, search, selectedRegistry, statusFilter, page]);

  /**
   * Loads all items without type filter to compute per-type counts for tabs.
   * Runs once on mount and after any item action (install/uninstall).
   */
  const loadTypeCounts = useCallback(async () => {
    try {
      const result = await browseMarketplace({ limit: 1000 });
      const counts = { all: result?.total || 0 };
      (result?.items || []).forEach(item => {
        counts[item.type] = (counts[item.type] || 0) + 1;
      });
      setTypeCounts(counts);
    } catch {
      // Counts are non-critical; silently ignore errors
    }
  }, []);

  /** Loads the list of registries for the filter dropdown */
  const loadRegistries = useCallback(async () => {
    try {
      const data = await fetchMarketplaceRegistries();
      setRegistries(Array.isArray(data) ? data : []);
    } catch {
      // Registry list is non-critical for browsing; silently ignore
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => {
    loadRegistries();
    loadTypeCounts();
  }, [loadRegistries, loadTypeCounts]);

  /**
   * Switches the active type filter and resets pagination to page 1.
   *
   * @param {string} type - The new type key to filter by
   */
  const handleTypeChange = type => {
    setActiveType(type);
    setPage(1);
  };

  /**
   * Updates the search query and resets pagination to page 1.
   *
   * @param {React.ChangeEvent<HTMLInputElement>} e - Input change event
   */
  const handleSearch = e => {
    setSearch(e.target.value);
    setPage(1);
  };

  /**
   * Refreshes item list and type counts after an install/uninstall/detach action.
   * Also invalidates the selected item so the detail panel re-fetches its data.
   */
  const handleItemAction = () => {
    loadItems();
    loadTypeCounts();
    if (selectedItem) {
      // Force the detail panel to re-fetch by setting a new object reference
      setSelectedItem(prev => ({ ...prev }));
    }
  };

  const noRegistries = !loading && registries.length === 0;

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AdminNavigation />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Page header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                {t('admin.nav.marketplace', 'Marketplace')}
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1">
                {t('admin.marketplace.subtitle', 'Discover and install content from registries')}
              </p>
            </div>
            <Link
              to="/admin/marketplace/registries"
              className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-sm font-medium"
            >
              {t('admin.marketplace.manageRegistries', 'Manage Registries')}
            </Link>
          </div>

          {/* Empty state: no registries configured */}
          {noRegistries && (
            <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="text-4xl mb-4" aria-hidden="true">
                &#x1F3EA;
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                {t('admin.marketplace.noRegistries.title', 'No registries configured')}
              </h3>
              <p className="text-gray-500 dark:text-gray-400 mb-6 max-w-md mx-auto">
                {t(
                  'admin.marketplace.noRegistries.description',
                  'Add a marketplace registry to discover and install apps, models, prompts, skills, and workflows.'
                )}
              </p>
              <Link
                to="/admin/marketplace/registries"
                className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                {t('admin.marketplace.noRegistries.cta', 'Add Registry')}
              </Link>
            </div>
          )}

          {/* Main browse interface */}
          {!noRegistries && (
            <>
              {/* Type filter tabs */}
              <MarketplaceTypeTabs
                activeType={activeType}
                onChange={handleTypeChange}
                counts={typeCounts}
              />

              {/* Filter bar: search, registry selector, status selector */}
              <div className="flex flex-wrap gap-3 mb-6 mt-4">
                <input
                  type="text"
                  value={search}
                  onChange={handleSearch}
                  placeholder={t('admin.marketplace.searchPlaceholder', 'Search items...')}
                  className="flex-1 min-w-48 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
                />
                <select
                  value={selectedRegistry}
                  onChange={e => {
                    setSelectedRegistry(e.target.value);
                    setPage(1);
                  }}
                  className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
                >
                  <option value="">{t('admin.marketplace.allRegistries', 'All Registries')}</option>
                  {registries.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <select
                  value={statusFilter}
                  onChange={e => {
                    setStatusFilter(e.target.value);
                    setPage(1);
                  }}
                  className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
                >
                  <option value="all">{t('admin.marketplace.statusAll', 'All Status')}</option>
                  <option value="available">
                    {t('admin.marketplace.statusAvailable', 'Available')}
                  </option>
                  <option value="installed">
                    {t('admin.marketplace.statusInstalled', 'Installed')}
                  </option>
                </select>
              </div>

              {/* Loading spinner */}
              {loading && (
                <div className="flex items-center justify-center py-16">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
                </div>
              )}

              {/* Empty results state */}
              {!loading && items.length === 0 && (
                <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                  <p className="text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.marketplace.noResults',
                      'No items found. Try adjusting your filters or refreshing your registries.'
                    )}
                  </p>
                </div>
              )}

              {/* Item grid and pagination */}
              {!loading && items.length > 0 && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                    {items.map(item => (
                      <MarketplaceItemCard
                        key={`${item.registryId}-${item.type}-${item.name}`}
                        item={item}
                        onClick={() => setSelectedItem(item)}
                        onAction={handleItemAction}
                      />
                    ))}
                  </div>

                  {/* Pagination controls */}
                  {totalPages > 1 && (
                    <div className="flex justify-center gap-2">
                      <button
                        disabled={page <= 1}
                        onClick={() => setPage(p => p - 1)}
                        className="px-3 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm disabled:opacity-50 text-gray-700 dark:text-gray-300"
                      >
                        &#x2190;
                      </button>
                      <span className="px-3 py-1 text-sm text-gray-600 dark:text-gray-400">
                        {page} / {totalPages}
                      </span>
                      <button
                        disabled={page >= totalPages}
                        onClick={() => setPage(p => p + 1)}
                        className="px-3 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm disabled:opacity-50 text-gray-700 dark:text-gray-300"
                      >
                        &#x2192;
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Hidden from layout: total count display for accessibility */}
          {total > 0 && (
            <p className="sr-only">
              {total} {t('admin.marketplace.types.all', 'items')}
            </p>
          )}
        </main>
      </div>

      {/* Item detail slide-in panel */}
      {selectedItem && (
        <MarketplaceItemDetail
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onAction={handleItemAction}
        />
      )}
    </AdminAuth>
  );
};

export default AdminMarketplacePage;
