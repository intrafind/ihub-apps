import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall } from '../../../api/adminApi';
import { useFilterState } from '../hooks/useFilterState';

const ACTION_PILL_COLORS = {
  create: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  update: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  delete: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  toggle: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  import: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  export: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'
};

const DEFAULT_PILL_COLOR = 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';

const RESOURCE_TYPES = [
  'all',
  'app',
  'group',
  'model',
  'prompt',
  'platform',
  'backup',
  'source',
  'feature',
  'provider'
];

const ACTION_TYPES = ['all', 'create', 'update', 'delete', 'toggle', 'import', 'export'];

const PAGE_SIZE = 50;

function getDefaultFromDate() {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString().split('T')[0];
}

function getDefaultToDate() {
  return new Date().toISOString().split('T')[0];
}

function formatTimestamp(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function ActionPill({ action }) {
  const colorClass = ACTION_PILL_COLORS[action] || DEFAULT_PILL_COLOR;
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass}`}
    >
      {action}
    </span>
  );
}

function AuditLogRetentionBadge({ t }) {
  const [policy, setPolicy] = useState(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    makeAdminApiCall('/admin/audit-log/retention')
      .then(res => {
        if (!cancelled) setPolicy(res.data);
      })
      .catch(() => {
        if (!cancelled) setPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!policy) return null;

  const runCleanup = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const res = await makeAdminApiCall('/admin/audit-log/retention/run', { method: 'POST' });
      const removed = res.data?.deleted?.length ?? 0;
      setMessage(
        removed > 0
          ? t('admin.auditLog.cleanupRemoved', '{{count}} files removed', { count: removed })
          : t('admin.auditLog.cleanupNoop', 'Nothing to remove')
      );
    } catch (e) {
      setMessage(
        t('admin.auditLog.cleanupError', 'Cleanup failed: {{error}}', { error: e.message })
      );
    } finally {
      setRunning(false);
    }
  };

  const retentionLabel = policy.cleanupEnabled
    ? policy.retentionDays > 0
      ? t('admin.auditLog.retentionDays', 'Retain {{days}} days', { days: policy.retentionDays })
      : t('admin.auditLog.retentionForever', 'Retain forever')
    : t('admin.auditLog.retentionDisabled', 'Cleanup disabled');

  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700"
        title={t(
          'admin.auditLog.retentionHint',
          'Configured in platform.json → auditLog. Edit under Platform → Advanced.'
        )}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-12a.75.75 0 00-1.5 0v4a.75.75 0 00.25.56l3 2.75a.75.75 0 101.02-1.1l-2.77-2.54V6z"
            clipRule="evenodd"
          />
        </svg>
        {retentionLabel}
      </span>
      {policy.cleanupEnabled && policy.retentionDays > 0 && (
        <button
          type="button"
          onClick={runCleanup}
          disabled={running}
          className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 underline disabled:opacity-50"
        >
          {running
            ? t('admin.auditLog.cleanupRunning', 'Running…')
            : t('admin.auditLog.runCleanup', 'Run cleanup now')}
        </button>
      )}
      {message && <span className="text-xs text-gray-500 dark:text-gray-400">{message}</span>}
    </div>
  );
}

function AdminAuditLogPage() {
  const { t } = useTranslation();

  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filter state (URL-persisted)
  const [fromDate, setFromDate] = useFilterState('from', getDefaultFromDate());
  const [toDate, setToDate] = useFilterState('to', getDefaultToDate());
  const [adminFilter, setAdminFilter] = useFilterState('admin', 'all');
  const [resourceFilter, setResourceFilter] = useFilterState('resource', 'all');
  const [actionFilter, setActionFilter] = useFilterState('action', 'all');

  // Pagination
  const [offset, setOffset] = useState(0);
  const [expandedRows, setExpandedRows] = useState(new Set());

  const toggleRow = id => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Admin list for dropdown
  const [adminList, setAdminList] = useState([]);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      if (adminFilter && adminFilter !== 'all') params.set('admin', adminFilter);
      if (resourceFilter && resourceFilter !== 'all') params.set('resource', resourceFilter);
      if (actionFilter && actionFilter !== 'all') params.set('action', actionFilter);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));

      const response = await makeAdminApiCall(`/admin/audit-log?${params.toString()}`);
      const data = response.data;

      setEntries(data.entries || []);
      setTotal(data.total || 0);

      // Build admin list from entries for the dropdown
      if (data.entries && data.entries.length > 0) {
        setAdminList(prev => {
          const existing = new Set(prev);
          for (const entry of data.entries) {
            if (entry.admin) existing.add(entry.admin);
          }
          const sorted = Array.from(existing).sort();
          if (sorted.length !== prev.length || sorted.some((v, i) => v !== prev[i])) {
            return sorted;
          }
          return prev;
        });
      }
    } catch (err) {
      setError(
        err.response?.data?.error ||
          err.message ||
          t('admin.auditLog.fetchError', 'Failed to fetch audit log')
      );
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, adminFilter, resourceFilter, actionFilter, offset, t]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // Reset offset when filters change
  const handleFilterChange = useCallback(setter => {
    return e => {
      setter(e.target.value);
      setOffset(0);
    };
  }, []);

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const showFrom = total > 0 ? offset + 1 : 0;
  const showTo = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t('admin.auditLog.title', 'Audit Log')}
        </h1>
        <AuditLogRetentionBadge t={t} />
      </div>

      {/* Filter Bar */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* From Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.auditLog.from', 'From')}
            </label>
            <input
              type="date"
              value={fromDate}
              onChange={handleFilterChange(setFromDate)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* To Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.auditLog.to', 'To')}
            </label>
            <input
              type="date"
              value={toDate}
              onChange={handleFilterChange(setToDate)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Admin Dropdown */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.auditLog.admin', 'Admin')}
            </label>
            <select
              value={adminFilter}
              onChange={handleFilterChange(setAdminFilter)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">{t('admin.auditLog.allAdmins', 'All Admins')}</option>
              {adminList.map(admin => (
                <option key={admin} value={admin}>
                  {admin}
                </option>
              ))}
            </select>
          </div>

          {/* Resource Type Dropdown */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.auditLog.resource', 'Resource')}
            </label>
            <select
              value={resourceFilter}
              onChange={handleFilterChange(setResourceFilter)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {RESOURCE_TYPES.map(type => (
                <option key={type} value={type}>
                  {type === 'all'
                    ? t('admin.auditLog.allResources', 'All Resources')
                    : t(
                        `admin.auditLog.resource.${type}`,
                        type.charAt(0).toUpperCase() + type.slice(1)
                      )}
                </option>
              ))}
            </select>
          </div>

          {/* Action Type Dropdown */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.auditLog.action', 'Action')}
            </label>
            <select
              value={actionFilter}
              onChange={handleFilterChange(setActionFilter)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {ACTION_TYPES.map(type => (
                <option key={type} value={type}>
                  {type === 'all'
                    ? t('admin.auditLog.allActions', 'All Actions')
                    : t(
                        `admin.auditLog.action.${type}`,
                        type.charAt(0).toUpperCase() + type.slice(1)
                      )}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-6">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {t('admin.auditLog.timestamp', 'Timestamp')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {t('admin.auditLog.adminColumn', 'Admin')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {t('admin.auditLog.actionColumn', 'Action')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {t('admin.auditLog.resourceColumn', 'Resource')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {t('admin.auditLog.summaryColumn', 'Summary')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="flex items-center justify-center">
                      <svg
                        className="animate-spin h-6 w-6 text-blue-500 mr-3"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      <span className="text-gray-500 dark:text-gray-400">
                        {t('admin.auditLog.loading', 'Loading audit log...')}
                      </span>
                    </div>
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-12 text-center text-gray-500 dark:text-gray-400"
                  >
                    {t('admin.auditLog.noEntries', 'No audit log entries found.')}
                  </td>
                </tr>
              ) : (
                entries.map((entry, index) => {
                  const rowKey = entry.id || `${entry.ts}-${index}`;
                  const isExpanded = expandedRows.has(rowKey);
                  const summary = entry.summary || '-';
                  const isLong = summary.length > 80;
                  return (
                    <tr key={rowKey} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                        {formatTimestamp(entry.ts)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                        {entry.admin || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <ActionPill action={entry.action} />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                        {entry.resource || '-'}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-300 max-w-md">
                        {isLong && !isExpanded ? (
                          <div>
                            <span className="block truncate">{summary}</span>
                            <button
                              onClick={() => toggleRow(rowKey)}
                              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mt-0.5"
                            >
                              {t('admin.auditLog.showMore', 'Show more')}
                            </button>
                          </div>
                        ) : isLong ? (
                          <div>
                            <span className="block break-words whitespace-pre-wrap">{summary}</span>
                            <button
                              onClick={() => toggleRow(rowKey)}
                              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mt-0.5"
                            >
                              {t('admin.auditLog.showLess', 'Show less')}
                            </button>
                          </div>
                        ) : (
                          summary
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <div className="bg-white dark:bg-gray-800 px-6 py-3 flex items-center justify-between border-t border-gray-200 dark:border-gray-700">
            <div className="text-sm text-gray-700 dark:text-gray-300">
              {t('admin.auditLog.showing', '{{from}}-{{to}} of {{total}}', {
                from: showFrom,
                to: showTo,
                total
              })}
            </div>
            <div className="flex space-x-2">
              <button
                onClick={() => setOffset(prev => Math.max(0, prev - PAGE_SIZE))}
                disabled={currentPage <= 1}
                className="px-3 py-1 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('admin.auditLog.previous', 'Previous')}
              </button>
              <button
                onClick={() => setOffset(prev => prev + PAGE_SIZE)}
                disabled={currentPage >= totalPages}
                className="px-3 py-1 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('admin.auditLog.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminAuditLogPage;
