import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { makeAdminApiCall } from '../../../api/adminApi';
import { getLocalizedContent } from '../../../utils/localizeContent';

const FIELD_CLASS =
  'rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500';

const NO_KEY_BADGE = 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300';
const KEY_BADGE = 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300';

function catalogAuthLabel(auth, t) {
  if (auth?.type === 'basic') {
    return t('admin.mcp.catalog.auth.basic', 'Username & API token');
  }
  if (auth?.type === 'bearer' || auth?.type === 'header') {
    return t('admin.mcp.catalog.auth.apiKey', 'API key');
  }
  return t('admin.mcp.catalog.auth.none', 'No key needed');
}

/**
 * Picker for the built-in catalog of hosted MCP servers. Selecting an entry
 * hands it to `onSelect`, which pre-fills the regular create dialog — the
 * admin still supplies the credential, tests and saves.
 */
function McpServerCatalogDialog({ onClose, onSelect }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [entries, setEntries] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await makeAdminApiCall('/admin/mcp/catalog');
        if (cancelled) return;
        setEntries(data.entries || []);
        setCategories(data.categories || []);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(entry => {
      if (category && entry.category !== category) return false;
      if (!q) return true;
      const haystack = [
        entry.name,
        entry.vendor,
        getLocalizedContent(entry.description, lang),
        ...(entry.tags || [])
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [entries, search, category, lang]);

  const categoryLabel = id => t(`admin.mcp.catalog.categories.${id}`, id);

  return (
    <div className="fixed z-20 inset-0 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 py-8">
        <div className="fixed inset-0 bg-gray-500/75 dark:bg-gray-900/75" />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mcp-catalog-title"
          className="relative bg-white dark:bg-gray-800 rounded-lg p-6 max-w-5xl w-full shadow-xl max-h-[90vh] flex flex-col"
        >
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2
                id="mcp-catalog-title"
                className="text-xl font-bold text-gray-900 dark:text-gray-100"
              >
                {t('admin.mcp.catalog.title', 'MCP server catalog')}
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {t(
                  'admin.mcp.catalog.subtitle',
                  'Hosted MCP servers iHub can connect to. Pick one to pre-fill the form, then add its API key, test and save.'
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close', 'Close')}
              className="ml-4 p-1 rounded-md text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <Icon name="x" size="md" />
            </button>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <div className="relative flex-1 min-w-48">
              <Icon
                name="search"
                size="sm"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('admin.mcp.catalog.searchPlaceholder', 'Search servers…')}
                aria-label={t('admin.mcp.catalog.searchPlaceholder', 'Search servers…')}
                className={`${FIELD_CLASS} w-full pl-9`}
                ref={searchRef}
              />
            </div>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              aria-label={t('admin.mcp.catalog.category', 'Category')}
              className={FIELD_CLASS}
            >
              <option value="">{t('admin.mcp.catalog.allCategories', 'All categories')}</option>
              {categories.map(id => (
                <option key={id} value={id}>
                  {categoryLabel(id)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 overflow-y-auto -mx-1 px-1">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <LoadingSpinner size="lg" />
              </div>
            ) : error ? (
              <div className="p-4 rounded-md border bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300">
                {t('admin.mcp.catalog.loadError', 'Failed to load the catalog: {{error}}', {
                  error
                })}
              </div>
            ) : visible.length === 0 ? (
              <p className="py-16 text-center text-sm text-gray-500 dark:text-gray-400">
                {t('admin.mcp.catalog.noResults', 'No servers match your search.')}
              </p>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {visible.map(entry => (
                  <li
                    key={entry.id}
                    className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                        {entry.name}
                      </h3>
                      {entry.installed && (
                        <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                          <Icon name="check" size="xs" className="mr-1" />
                          {t('admin.mcp.catalog.installed', 'Added')}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                        {categoryLabel(entry.category)}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          entry.auth?.type === 'none' ? NO_KEY_BADGE : KEY_BADGE
                        }`}
                      >
                        {catalogAuthLabel(entry.auth, t)}
                      </span>
                    </div>
                    <p className="mt-2 flex-1 text-sm text-gray-600 dark:text-gray-400">
                      {getLocalizedContent(entry.description, lang)}
                    </p>
                    <div className="mt-4 flex items-center justify-between">
                      {entry.docsUrl ? (
                        <a
                          href={entry.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {t('admin.mcp.catalog.docs', 'Documentation')}
                          <Icon name="external-link" size="xs" className="ml-1" />
                        </a>
                      ) : (
                        <span />
                      )}
                      <button
                        type="button"
                        onClick={() => onSelect(entry)}
                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                      >
                        <Icon name="plus" size="sm" className="mr-1" />
                        {t('admin.mcp.catalog.use', 'Add')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default McpServerCatalogDialog;
