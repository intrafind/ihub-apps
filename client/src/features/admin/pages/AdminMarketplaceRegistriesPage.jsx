import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import {
  fetchMarketplaceRegistries,
  deleteMarketplaceRegistry,
  refreshMarketplaceRegistry,
  updateMarketplaceRegistry
} from '../../../api/adminApi';
import RegistryFormDialog from '../components/marketplace/RegistryFormDialog';

/**
 * Admin page for managing marketplace registries.
 *
 * Allows administrators to view, create, edit, delete, and refresh
 * marketplace registries. Each registry provides a catalog of installable
 * content (apps, models, prompts, skills, workflows).
 *
 * Follows the same layout and UX patterns as AdminProvidersPage.
 */
const AdminMarketplaceRegistriesPage = () => {
  const { t } = useTranslation();
  const [registries, setRegistries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRegistry, setEditingRegistry] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);

  /**
   * Loads all registries from the server and updates local state.
   * Wrapped in useCallback to be a stable dependency for useEffect.
   */
  const loadRegistries = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchMarketplaceRegistries();
      setRegistries(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load registries');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRegistries();
  }, [loadRegistries]);

  /**
   * Triggers a manual sync/refresh of the registry's remote catalog.
   *
   * @param {string} id - The registry ID to refresh
   */
  const handleRefresh = async id => {
    setRefreshingId(id);
    try {
      await refreshMarketplaceRegistry(id);
      await loadRegistries();
    } catch (err) {
      alert(err.message || 'Refresh failed');
    } finally {
      setRefreshingId(null);
    }
  };

  /**
   * Deletes a registry after user confirmation.
   *
   * @param {Object} registry - The registry object to delete
   */
  const handleDelete = async registry => {
    if (
      !confirm(
        t(
          'admin.marketplace.registries.confirmDelete',
          `Delete registry "${registry.name}"? This will remove all cached catalog data.`
        )
      )
    )
      return;
    try {
      await deleteMarketplaceRegistry(registry.id);
      await loadRegistries();
    } catch (err) {
      alert(err.message || 'Delete failed');
    }
  };

  /**
   * Toggles the enabled/disabled state of a registry.
   *
   * @param {Object} registry - The registry object to toggle
   */
  const handleToggleEnabled = async registry => {
    try {
      await updateMarketplaceRegistry(registry.id, { ...registry, enabled: !registry.enabled });
      await loadRegistries();
    } catch (err) {
      alert(err.message || 'Update failed');
    }
  };

  /**
   * Called after a successful save in the form dialog.
   * Closes the dialog and reloads the registry list.
   */
  const handleSaved = () => {
    setShowForm(false);
    setEditingRegistry(null);
    loadRegistries();
  };

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AdminNavigation />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Page header with breadcrumb and add button */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mb-1">
                <Link to="/admin/marketplace" className="hover:text-blue-600">
                  {t('admin.nav.marketplace', 'Marketplace')}
                </Link>
                <span>/</span>
                <span>{t('admin.marketplace.registries.title', 'Registries')}</span>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                {t('admin.marketplace.registries.title', 'Marketplace Registries')}
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1">
                {t(
                  'admin.marketplace.registries.subtitle',
                  'Manage content registries to discover and install apps, models, prompts, skills, and workflows.'
                )}
              </p>
            </div>
            <button
              onClick={() => {
                setEditingRegistry(null);
                setShowForm(true);
              }}
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm"
            >
              + {t('admin.marketplace.registries.addRegistry', 'Add Registry')}
            </button>
          </div>

          {/* Loading spinner */}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && registries.length === 0 && (
            <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
              <p className="text-gray-500 dark:text-gray-400 mb-4">
                {t('admin.marketplace.registries.empty', 'No registries configured yet.')}
              </p>
              <button
                onClick={() => setShowForm(true)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                {t('admin.marketplace.registries.addFirst', 'Add your first registry')}
              </button>
            </div>
          )}

          {/* Registries table */}
          {!loading && registries.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('admin.marketplace.registries.columns.name', 'Name')}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('admin.marketplace.registries.columns.source', 'Source')}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('admin.marketplace.registries.columns.items', 'Items')}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('admin.marketplace.registries.columns.lastSynced', 'Last Synced')}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('common.enabled', 'Enabled')}
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('common.actions', 'Actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {registries.map(registry => (
                    <tr key={registry.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-6 py-4">
                        <div className="font-medium text-gray-900 dark:text-white">
                          {registry.name}
                        </div>
                        {registry.description && (
                          <div className="text-sm text-gray-500 dark:text-gray-400">
                            {registry.description}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div
                          className="text-sm text-gray-600 dark:text-gray-300 font-mono truncate max-w-xs"
                          title={registry.source}
                        >
                          {registry.source}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-300">
                        {registry.itemCount ?? '–'}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                        {registry.lastSynced
                          ? new Date(registry.lastSynced).toLocaleString()
                          : t('admin.marketplace.registries.neverSynced', 'Never')}
                      </td>
                      <td className="px-6 py-4">
                        {/* Toggle switch for enabled state */}
                        <button
                          onClick={() => handleToggleEnabled(registry)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            registry.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                          }`}
                          aria-label={
                            registry.enabled
                              ? t('common.disable', 'Disable')
                              : t('common.enable', 'Enable')
                          }
                        >
                          <span
                            className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                              registry.enabled ? 'translate-x-5' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleRefresh(registry.id)}
                            disabled={refreshingId === registry.id}
                            className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
                          >
                            {refreshingId === registry.id ? '...' : t('common.refresh', 'Refresh')}
                          </button>
                          <button
                            onClick={() => {
                              setEditingRegistry(registry);
                              setShowForm(true);
                            }}
                            className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
                          >
                            {t('common.edit', 'Edit')}
                          </button>
                          <button
                            onClick={() => handleDelete(registry)}
                            className="text-sm text-red-600 hover:text-red-700"
                          >
                            {t('common.delete', 'Delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>

      {/* Registry create/edit dialog */}
      {showForm && (
        <RegistryFormDialog
          registry={editingRegistry}
          onSave={handleSaved}
          onCancel={() => {
            setShowForm(false);
            setEditingRegistry(null);
          }}
        />
      )}
    </AdminAuth>
  );
};

export default AdminMarketplaceRegistriesPage;
