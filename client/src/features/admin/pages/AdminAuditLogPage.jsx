import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall } from '../../../api/adminApi';
import { useFilterState } from '../hooks/useFilterState';
import { DataTable, FilterSelect } from '../components/data-table';

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
  'provider',
  'auth',
  'user',
  'oauthClient',
  'oauthToken'
];

const ACTION_TYPES = [
  'all',
  'create',
  'update',
  'delete',
  'toggle',
  'import',
  'export',
  'login',
  'logout'
];

const RESULT_TYPES = ['all', 'success', 'failure'];

const SOURCE_TYPES = ['all', 'web', 'admin', 'api', 'mcp'];

const RESULT_PILL_COLORS = {
  success: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  failure: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
};

const DEFAULT_PAGE_SIZE = 50;

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
  return new Date(timestamp).toLocaleString();
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

function ResultPill({ result }) {
  const value = result || 'success';
  const colorClass = RESULT_PILL_COLORS[value] || DEFAULT_PILL_COLOR;
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass}`}
    >
      {value}
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
          'Configured in platform.json → audit. Edit under Platform → Advanced.'
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

function SummaryCell({ entry, expanded, onToggle, t }) {
  const summary = entry.summary || '-';
  const isLong = summary.length > 80;
  if (!isLong) return <span>{summary}</span>;
  return expanded ? (
    <div>
      <span className="block break-words whitespace-pre-wrap">{summary}</span>
      <button
        onClick={e => {
          e.stopPropagation();
          onToggle();
        }}
        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mt-0.5"
      >
        {t('admin.auditLog.showLess', 'Show less')}
      </button>
    </div>
  ) : (
    <div className="max-w-md">
      <span className="block truncate">{summary}</span>
      <button
        onClick={e => {
          e.stopPropagation();
          onToggle();
        }}
        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mt-0.5"
      >
        {t('admin.auditLog.showMore', 'Show more')}
      </button>
    </div>
  );
}

function AdminAuditLogPage() {
  const { t } = useTranslation();

  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [fromDate, setFromDate] = useFilterState('from', getDefaultFromDate());
  const [toDate, setToDate] = useFilterState('to', getDefaultToDate());
  const [actorFilter, setActorFilter] = useFilterState('actor', 'all');
  const [resourceFilter, setResourceFilter] = useFilterState('resource', 'all');
  const [actionFilter, setActionFilter] = useFilterState('action', 'all');
  const [resultFilter, setResultFilter] = useFilterState('result', 'all');
  const [sourceFilter, setSourceFilter] = useFilterState('source', 'all');
  const [pageParam, setPageParam] = useFilterState('page', '1');
  const [pageSizeParam, setPageSizeParam] = useFilterState('pageSize', String(DEFAULT_PAGE_SIZE));

  const page = Math.max(1, parseInt(pageParam, 10) || 1);
  const pageSize = Math.max(1, parseInt(pageSizeParam, 10) || DEFAULT_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const [expandedRows, setExpandedRows] = useState(new Set());
  const [actorList, setActorList] = useState([]);
  const [exporting, setExporting] = useState(false);

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (actorFilter && actorFilter !== 'all') params.set('actor', actorFilter);
    if (resourceFilter && resourceFilter !== 'all') params.set('resource', resourceFilter);
    if (actionFilter && actionFilter !== 'all') params.set('action', actionFilter);
    if (resultFilter && resultFilter !== 'all') params.set('result', resultFilter);
    if (sourceFilter && sourceFilter !== 'all') params.set('source', sourceFilter);
    return params;
  }, [fromDate, toDate, actorFilter, resourceFilter, actionFilter, resultFilter, sourceFilter]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const params = buildFilterParams();
      const response = await makeAdminApiCall(`/admin/audit-log/export?${params.toString()}`, {
        responseType: 'blob'
      });
      const blob = new Blob([response.data], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-log-${getDefaultToDate()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err.response?.data?.error ||
          err.message ||
          t('admin.auditLog.exportError', 'Failed to export audit log')
      );
    } finally {
      setExporting(false);
    }
  }, [buildFilterParams, t]);

  const toggleRow = id => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = buildFilterParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(offset));

      const response = await makeAdminApiCall(`/admin/audit-log?${params.toString()}`);
      const data = response.data;

      setEntries(data.entries || []);
      setTotal(data.total || 0);

      if (data.entries && data.entries.length > 0) {
        setActorList(prev => {
          const existing = new Set(prev);
          for (const entry of data.entries) {
            const name = entry.actor?.username ?? entry.admin;
            if (name) existing.add(name);
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
  }, [buildFilterParams, offset, pageSize, t]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleFilterChange = setter => value => {
    setter(value);
    setPageParam('1');
  };

  const columns = [
    {
      key: 'ts',
      header: t('admin.auditLog.timestamp', 'Timestamp'),
      render: e => (
        <span className="text-sm text-gray-600 dark:text-gray-300">{formatTimestamp(e.ts)}</span>
      )
    },
    {
      key: 'actor',
      header: t('admin.auditLog.actorColumn', 'Actor'),
      hideBelow: 'md',
      render: e => (
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {e.actor?.username ?? e.admin ?? '-'}
        </span>
      )
    },
    {
      key: 'action',
      header: t('admin.auditLog.actionColumn', 'Action'),
      render: e => <ActionPill action={e.action} />
    },
    {
      key: 'result',
      header: t('admin.auditLog.resultColumn', 'Result'),
      render: e => <ResultPill result={e.result} />
    },
    {
      key: 'resource',
      header: t('admin.auditLog.resourceColumn', 'Resource'),
      hideBelow: 'md',
      render: e => (
        <span className="text-sm text-gray-600 dark:text-gray-300">{e.resource || '-'}</span>
      )
    },
    {
      key: 'source',
      header: t('admin.auditLog.sourceColumn', 'Source'),
      hideBelow: 'lg',
      render: e => (
        <span className="text-sm text-gray-600 dark:text-gray-300">{e.source || '-'}</span>
      )
    },
    {
      key: 'summary',
      header: t('admin.auditLog.summaryColumn', 'Summary'),
      render: e => {
        const rowKey = e.id || `${e.ts}`;
        return (
          <SummaryCell
            entry={e}
            expanded={expandedRows.has(rowKey)}
            onToggle={() => toggleRow(rowKey)}
            t={t}
          />
        );
      }
    }
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t('admin.auditLog.title', 'Audit Log')}
        </h1>
        <div className="flex items-center gap-4">
          <AuditLogRetentionBadge t={t} />
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M10 3a.75.75 0 01.75.75v6.69l1.72-1.72a.75.75 0 111.06 1.06l-3 3a.75.75 0 01-1.06 0l-3-3a.75.75 0 111.06-1.06l1.72 1.72V3.75A.75.75 0 0110 3zM3.75 13a.75.75 0 01.75.75v1.5c0 .414.336.75.75.75h9.5a.75.75 0 00.75-.75v-1.5a.75.75 0 011.5 0v1.5A2.25 2.25 0 0115.25 17.5h-9.5A2.25 2.25 0 013.5 15.25v-1.5A.75.75 0 013.75 13z"
                clipRule="evenodd"
              />
            </svg>
            {exporting
              ? t('admin.auditLog.exporting', 'Exporting…')
              : t('admin.auditLog.exportCsv', 'Export CSV')}
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.auditLog.from', 'From')}
            </label>
            <input
              type="date"
              value={fromDate}
              onChange={e => handleFilterChange(setFromDate)(e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.auditLog.to', 'To')}
            </label>
            <input
              type="date"
              value={toDate}
              onChange={e => handleFilterChange(setToDate)(e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <FilterSelect
            label={t('admin.auditLog.actor', 'Actor')}
            value={actorFilter}
            onChange={handleFilterChange(setActorFilter)}
            options={[
              { value: 'all', label: t('admin.auditLog.allActors', 'All Actors') },
              ...actorList.map(a => ({ value: a, label: a }))
            ]}
          />
          <FilterSelect
            label={t('admin.auditLog.resource', 'Resource')}
            value={resourceFilter}
            onChange={handleFilterChange(setResourceFilter)}
            options={RESOURCE_TYPES.map(type => ({
              value: type,
              label:
                type === 'all'
                  ? t('admin.auditLog.allResources', 'All Resources')
                  : t(
                      `admin.auditLog.resource.${type}`,
                      type.charAt(0).toUpperCase() + type.slice(1)
                    )
            }))}
          />
          <FilterSelect
            label={t('admin.auditLog.action', 'Action')}
            value={actionFilter}
            onChange={handleFilterChange(setActionFilter)}
            options={ACTION_TYPES.map(type => ({
              value: type,
              label:
                type === 'all'
                  ? t('admin.auditLog.allActions', 'All Actions')
                  : t(`admin.auditLog.action.${type}`, type.charAt(0).toUpperCase() + type.slice(1))
            }))}
          />
          <FilterSelect
            label={t('admin.auditLog.result', 'Result')}
            value={resultFilter}
            onChange={handleFilterChange(setResultFilter)}
            options={RESULT_TYPES.map(type => ({
              value: type,
              label:
                type === 'all'
                  ? t('admin.auditLog.allResults', 'All Results')
                  : t(`admin.auditLog.result.${type}`, type.charAt(0).toUpperCase() + type.slice(1))
            }))}
          />
          <FilterSelect
            label={t('admin.auditLog.source', 'Source')}
            value={sourceFilter}
            onChange={handleFilterChange(setSourceFilter)}
            options={SOURCE_TYPES.map(type => ({
              value: type,
              label:
                type === 'all'
                  ? t('admin.auditLog.allSources', 'All Sources')
                  : t(`admin.auditLog.source.${type}`, type.charAt(0).toUpperCase() + type.slice(1))
            }))}
          />
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-6">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      <DataTable
        columns={columns}
        data={entries}
        getRowId={e => e.id || `${e.ts}`}
        loading={loading}
        pagination={{
          mode: 'server',
          total,
          page,
          pageSize,
          onPageChange: p => setPageParam(String(p)),
          onPageSizeChange: size => {
            setPageSizeParam(String(size));
            setPageParam('1');
          },
          pageSizeOptions: [25, 50, 100, 200]
        }}
        empty={{
          icon: 'document-search',
          title: t('admin.auditLog.noEntries', 'No audit log entries found.')
        }}
      />
    </div>
  );
}

export default AdminAuditLogPage;
