import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall } from '../../../api/adminApi';
import { useFilterParams } from '../hooks/useFilterState';
import { DataTable, FilterMultiSelect, SearchInput } from '../components/data-table';
import {
  FILTER_FIELDS,
  encodeSelection,
  isFieldFiltered,
  mergeFilterOptions,
  parseFilterParam,
  selectedOptionValues,
  setExcluded
} from '../utils/auditLogFilters';

const ACTION_PILL_COLORS = {
  create: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  update: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  delete: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  toggle: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  import: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  export: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'
};

const DEFAULT_PILL_COLOR = 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';

const RESULT_PILL_COLORS = {
  success: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  failure: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
};

const DEFAULT_PAGE_SIZE = 50;

// Default window. One day keeps the first page load to one or two daily files;
// the date inputs and the range presets widen it.
const DEFAULT_RANGE_DAYS = 1;

// Actions the "hide sign-in noise" preset excludes — the ticket's actual
// complaint is that logins drown out everything else.
const NOISY_ACTIONS = ['login', 'logout'];

// Closed vocabularies worth translating. `resource` and `actor` are open-ended
// (the audit middleware derives resource names from request paths), so their
// values are shown verbatim.
const TRANSLATED_VALUE_FIELDS = new Set(['action', 'result', 'source']);

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

function getDefaultFromDate() {
  return daysAgo(DEFAULT_RANGE_DAYS);
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

/** A one-click filter shortcut. Reflects whether its filter is currently on. */
function PresetChip({ active, onClick, children, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-900/30 dark:text-indigo-300'
          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
      }`}
    >
      {children}
    </button>
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

const EMPTY_FACETS = Object.freeze({
  actor: [],
  resource: [],
  action: [],
  result: [],
  source: []
});

function AdminAuditLogPage() {
  const { t } = useTranslation();

  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const [exporting, setExporting] = useState(false);

  // A filter change also has to reset the page, and React Router's
  // setSearchParams does not queue: two calls in one tick lose the first. Every
  // update below therefore goes through a single setMany().
  const defaults = useMemo(
    () => ({
      from: getDefaultFromDate(),
      to: getDefaultToDate(),
      page: '1',
      pageSize: String(DEFAULT_PAGE_SIZE)
    }),
    []
  );
  const { searchParams, get, getAll, setMany } = useFilterParams(defaults);

  const fromDate = get('from');
  const toDate = get('to');
  const queryText = get('q');
  const page = Math.max(1, parseInt(get('page'), 10) || 1);
  const pageSize = Math.max(1, parseInt(get('pageSize'), 10) || DEFAULT_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  // The include/exclude sets currently in the URL, per field.
  const filterSets = useMemo(() => {
    const sets = {};
    for (const field of FILTER_FIELDS) {
      sets[field] = {
        include: parseFilterParam(getAll(field), field),
        exclude: parseFilterParam(getAll(`${field}Exclude`), field)
      };
    }
    return sets;
  }, [getAll]);

  // Checkbox options come from the server-computed facets for the date range,
  // unioned with any value the current filter names, so an active filter is
  // always visible in the list that produced it.
  const filterOptions = useMemo(() => {
    const options = {};
    for (const field of FILTER_FIELDS) {
      const { include, exclude } = filterSets[field];
      options[field] = mergeFilterOptions(facets[field], include, exclude);
    }
    return options;
  }, [facets, filterSets]);

  const anyFilterActive =
    FILTER_FIELDS.some(field =>
      isFieldFiltered(filterSets[field].include, filterSets[field].exclude)
    ) ||
    Boolean(queryText) ||
    fromDate !== defaults.from ||
    toDate !== defaults.to;

  // The filter parameters, verbatim, are also the API parameters — so a shared
  // URL, the table and a CSV export can never disagree.
  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    for (const field of FILTER_FIELDS) {
      for (const name of [field, `${field}Exclude`]) {
        for (const value of searchParams.getAll(name)) params.append(name, value);
      }
    }
    if (queryText) params.set('q', queryText);
    return params.toString();
  }, [searchParams, fromDate, toDate, queryText]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const response = await makeAdminApiCall(`/admin/audit-log/export?${filterQuery}`, {
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
  }, [filterQuery, t]);

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
      const params = new URLSearchParams(filterQuery);
      params.set('limit', String(pageSize));
      params.set('offset', String(offset));
      // Facets are computed in the same file scan as the query, so asking for
      // them does not cost a second pass over the log.
      params.set('facets', '1');

      const response = await makeAdminApiCall(`/admin/audit-log?${params.toString()}`);
      const data = response.data;

      setEntries(data.entries || []);
      setTotal(data.total || 0);
      if (data.facets) setFacets(data.facets);
    } catch (err) {
      setError(
        err.response?.data?.error ||
          err.message ||
          t('admin.auditLog.fetchError', 'Failed to fetch audit log')
      );
    } finally {
      setLoading(false);
    }
  }, [filterQuery, offset, pageSize, t]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  /** Apply filter updates and return to page 1, in one navigation. */
  const applyFilter = useCallback(updates => setMany({ ...updates, page: null }), [setMany]);

  const handleSelectionChange = useCallback(
    (field, selected) => applyFilter(encodeSelection(field, filterOptions[field], selected)),
    [applyFilter, filterOptions]
  );

  const clearAllFilters = useCallback(() => {
    const updates = { from: null, to: null, q: null, page: null };
    for (const field of FILTER_FIELDS) {
      updates[field] = null;
      updates[`${field}Exclude`] = null;
    }
    setMany(updates);
  }, [setMany]);

  const noiseHidden = NOISY_ACTIONS.every(a => filterSets.action.exclude?.has(a));
  const failuresOnly =
    filterSets.result.include?.size === 1 && filterSets.result.include.has('failure');

  const valueLabel = useCallback(
    (field, value) =>
      TRANSLATED_VALUE_FIELDS.has(field)
        ? t(`admin.auditLog.values.${field}.${value}`, value)
        : value,
    [t]
  );

  const filterControls = [
    {
      field: 'actor',
      label: t('admin.auditLog.filters.actor', 'Actor'),
      allLabel: t('admin.auditLog.filters.allActors', 'All actors'),
      noneLabel: t('admin.auditLog.filters.noActors', 'No actors')
    },
    {
      field: 'resource',
      label: t('admin.auditLog.filters.resource', 'Resource'),
      allLabel: t('admin.auditLog.filters.allResources', 'All resources'),
      noneLabel: t('admin.auditLog.filters.noResources', 'No resources')
    },
    {
      field: 'action',
      label: t('admin.auditLog.filters.action', 'Action'),
      allLabel: t('admin.auditLog.filters.allActions', 'All actions'),
      noneLabel: t('admin.auditLog.filters.noActions', 'No actions')
    },
    {
      field: 'result',
      label: t('admin.auditLog.filters.result', 'Result'),
      allLabel: t('admin.auditLog.filters.allResults', 'All results'),
      noneLabel: t('admin.auditLog.filters.noResults', 'No results')
    },
    {
      field: 'source',
      label: t('admin.auditLog.filters.source', 'Source'),
      allLabel: t('admin.auditLog.filters.allSources', 'All sources'),
      noneLabel: t('admin.auditLog.filters.noSources', 'No sources')
    }
  ];

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
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('admin.auditLog.presets.label', 'Quick filters')}
          </span>
          <PresetChip
            active={fromDate === daysAgo(1) && toDate === getDefaultToDate()}
            onClick={() => applyFilter({ from: daysAgo(1), to: getDefaultToDate() })}
          >
            {t('admin.auditLog.presets.last24h', 'Last 24 hours')}
          </PresetChip>
          <PresetChip
            active={fromDate === daysAgo(7) && toDate === getDefaultToDate()}
            onClick={() => applyFilter({ from: daysAgo(7), to: getDefaultToDate() })}
          >
            {t('admin.auditLog.presets.last7Days', 'Last 7 days')}
          </PresetChip>
          <PresetChip
            active={fromDate === daysAgo(30) && toDate === getDefaultToDate()}
            onClick={() => applyFilter({ from: daysAgo(30), to: getDefaultToDate() })}
          >
            {t('admin.auditLog.presets.last30Days', 'Last 30 days')}
          </PresetChip>
          <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-600" aria-hidden="true" />
          <PresetChip
            active={noiseHidden}
            onClick={() =>
              applyFilter(
                setExcluded('action', filterSets.action.exclude, NOISY_ACTIONS, !noiseHidden)
              )
            }
          >
            {t('admin.auditLog.presets.hideSignIns', 'Hide sign-ins')}
          </PresetChip>
          <PresetChip
            active={failuresOnly}
            onClick={() =>
              applyFilter({ result: failuresOnly ? null : 'failure', resultExclude: null })
            }
          >
            {t('admin.auditLog.presets.failuresOnly', 'Failures only')}
          </PresetChip>
          {anyFilterActive && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="ml-auto text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {t('admin.auditLog.presets.clearAll', 'Clear all filters')}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-4">
          <div>
            <label
              htmlFor="audit-from"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('admin.auditLog.filters.from', 'From')}
            </label>
            <input
              id="audit-from"
              type="date"
              value={fromDate}
              onChange={e => applyFilter({ from: e.target.value })}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label
              htmlFor="audit-to"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('admin.auditLog.filters.to', 'To')}
            </label>
            <input
              id="audit-to"
              type="date"
              value={toDate}
              onChange={e => applyFilter({ to: e.target.value })}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {filterControls.map(({ field, label, allLabel, noneLabel }) => (
            <FilterMultiSelect
              key={field}
              label={label}
              allLabel={allLabel}
              noneLabel={noneLabel}
              options={filterOptions[field].map(o => ({
                value: o.value,
                label: valueLabel(field, o.value),
                count: o.count
              }))}
              selected={selectedOptionValues(
                filterOptions[field],
                filterSets[field].include,
                filterSets[field].exclude
              )}
              onChange={selected => handleSelectionChange(field, selected)}
              searchPlaceholder={t('admin.auditLog.filters.filterValues', 'Filter values…')}
              emptyLabel={t('admin.auditLog.filters.noValues', 'No values in range')}
            />
          ))}

          <div>
            <label
              htmlFor="audit-search"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('admin.auditLog.filters.search', 'Search')}
            </label>
            <SearchInput
              value={queryText}
              onChange={value => applyFilter({ q: value })}
              placeholder={t('admin.auditLog.filters.searchPlaceholder', 'Summary, ID, IP…')}
              ariaLabel={t(
                'admin.auditLog.filters.searchHint',
                'Search summary, resource ID, IP, request ID and actor'
              )}
              className="max-w-full"
            />
          </div>
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
          onPageChange: p => setMany({ page: String(p) }),
          onPageSizeChange: size => setMany({ pageSize: String(size), page: null }),
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
