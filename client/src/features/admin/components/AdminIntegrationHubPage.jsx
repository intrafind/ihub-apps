import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import AdminBreadcrumb from './AdminBreadcrumb';
import AdminEmptyState from './AdminEmptyState';

const STATUS_STYLES = {
  connected:
    'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800',
  available:
    'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700',
  disabled:
    'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  error:
    'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
};

const STATUS_LABELS = {
  connected: 'Connected',
  available: 'Available',
  disabled: 'Disabled',
  error: 'Needs attention'
};

function StatusPill({ status }) {
  const styles = STATUS_STYLES[status] ?? STATUS_STYLES.available;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${styles}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function IntegrationCard({ integration }) {
  const { title, description, icon, color, href, status, badge } = integration;
  const inner = (
    <div className="group relative h-full bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 p-5 transition-all active:scale-[0.99]">
      <div className="flex items-start justify-between mb-3">
        <div
          className={`p-2 rounded-lg ${color ?? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400'}`}
        >
          <Icon name={icon ?? 'settings'} className="w-5 h-5" />
        </div>
        <div className="flex items-center gap-2">
          {badge && (
            <span className="text-xs text-gray-500 dark:text-gray-400 px-1.5 py-0.5">{badge}</span>
          )}
          {status && <StatusPill status={status} />}
        </div>
      </div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-2">{description}</p>
      )}
    </div>
  );
  if (!href) return inner;
  return (
    <Link to={href} className="block h-full">
      {inner}
    </Link>
  );
}

/**
 * Hub page layout for admin integration / category pages.
 *
 * Header (title + description) → search box → category-grouped cards with
 * status pills. Integrations are passed as a flat array; grouping is derived
 * from each integration's `category` field (falls back to "Other").
 *
 * @param {Object} props
 * @param {Array<{label: string, href?: string}>} [props.crumbs]
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {Array<{
 *   id: string,
 *   title: string,
 *   description?: string,
 *   icon?: string,
 *   color?: string,
 *   href?: string,
 *   status?: 'connected'|'available'|'disabled'|'error',
 *   category?: string,
 *   badge?: string
 * }>} props.integrations
 * @param {Array<string>} [props.categoryOrder] Optional order for category sections
 * @param {string} [props.searchPlaceholder='Search integrations…']
 * @param {React.ReactNode} [props.actions] Header right-side actions
 */
function AdminIntegrationHubPage({
  crumbs,
  title,
  description,
  integrations = [],
  categoryOrder,
  searchPlaceholder = 'Search integrations…',
  actions
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return integrations;
    const q = query.toLowerCase();
    return integrations.filter(
      i =>
        i.title?.toLowerCase().includes(q) ||
        i.description?.toLowerCase().includes(q) ||
        i.category?.toLowerCase().includes(q)
    );
  }, [integrations, query]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const i of filtered) {
      const cat = i.category || 'Other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(i);
    }
    let entries = Array.from(map.entries());
    if (categoryOrder?.length) {
      entries.sort(([a], [b]) => {
        const ai = categoryOrder.indexOf(a);
        const bi = categoryOrder.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    } else {
      entries.sort(([a], [b]) => a.localeCompare(b));
    }
    return entries;
  }, [filtered, categoryOrder]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {crumbs && crumbs.length > 0 && <AdminBreadcrumb crumbs={crumbs} />}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2 sm:shrink-0">{actions}</div>}
      </div>

      <div className="mb-6 relative">
        <Icon
          name="search"
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500 pointer-events-none"
        />
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          className="block w-full pl-9 pr-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 text-sm"
          aria-label="Search integrations"
        />
      </div>

      {filtered.length === 0 ? (
        <AdminEmptyState
          icon="search"
          title="No integrations found"
          description={query ? `No matches for "${query}". Try a different search.` : undefined}
        />
      ) : (
        <div className="space-y-8">
          {grouped.map(([category, items]) => (
            <section key={category}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
                {category}
                <span className="ml-2 text-gray-400 dark:text-gray-500 font-normal">
                  ({items.length})
                </span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {items.map(i => (
                  <IntegrationCard key={i.id} integration={i} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default AdminIntegrationHubPage;
