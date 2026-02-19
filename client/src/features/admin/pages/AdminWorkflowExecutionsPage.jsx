/**
 * AdminWorkflowExecutionsPage
 *
 * Admin page for viewing and managing workflow executions across all users.
 * Provides a filterable, searchable table of all workflow executions with
 * auto-refresh capability and the ability to inspect or cancel executions.
 *
 * @module features/admin/pages/AdminWorkflowExecutionsPage
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { fetchAdminExecutions, cancelAdminExecution } from '../../../api/adminApi';

/**
 * Auto-refresh polling interval in milliseconds (5 seconds)
 * @constant {number}
 */
const POLL_INTERVAL_MS = 5000;

/**
 * Maps execution status values to display badge styles.
 *
 * @param {string} status - Execution status string
 * @returns {{ bg: string, text: string }} Tailwind CSS classes for badge styling
 */
function getStatusBadgeClasses(status) {
  switch (status) {
    case 'completed':
      return {
        bg: 'bg-green-100 dark:bg-green-900/30',
        text: 'text-green-800 dark:text-green-300'
      };
    case 'running':
      return { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-800 dark:text-blue-300' };
    case 'paused':
      return {
        bg: 'bg-yellow-100 dark:bg-yellow-900/30',
        text: 'text-yellow-800 dark:text-yellow-300'
      };
    case 'failed':
      return { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-800 dark:text-red-300' };
    case 'cancelled':
      return { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-800 dark:text-gray-300' };
    case 'pending':
      return {
        bg: 'bg-purple-100 dark:bg-purple-900/30',
        text: 'text-purple-800 dark:text-purple-300'
      };
    default:
      return { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-600 dark:text-gray-400' };
  }
}

/**
 * Computes a human-readable duration string from a start time to an optional end time.
 *
 * @param {string} startedAt - ISO timestamp for the start of the execution
 * @param {string|null} completedAt - ISO timestamp for the end of the execution, or null if still active
 * @returns {string} A human-readable duration string (e.g. "2m 34s", "1h 5m")
 */
function computeDuration(startedAt, completedAt) {
  if (!startedAt) return '-';
  const start = new Date(startedAt);
  const end = completedAt ? new Date(completedAt) : new Date();
  const diffMs = end - start;

  if (diffMs < 0) return '-';

  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Shortens an execution ID to its first 16 characters for display.
 *
 * @param {string} id - Full execution ID
 * @returns {string} Truncated execution ID
 */
function shortenId(id) {
  if (!id) return '-';
  return id.length > 16 ? id.substring(0, 16) : id;
}

/**
 * AdminWorkflowExecutionsPage component.
 *
 * Displays a table of all workflow executions with:
 * - Auto-refresh toggle (polls every 5 seconds when enabled)
 * - Status filter dropdown (All, Running, Paused, Completed, Failed, Cancelled)
 * - Search by user/workflow name
 * - Actions: View/Inspect and Cancel
 *
 * @returns {JSX.Element} The rendered admin workflow executions page
 */
const AdminWorkflowExecutionsPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();

  const [executions, setExecutions] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [cancellingId, setCancellingId] = useState(null);

  /** @type {React.MutableRefObject<NodeJS.Timeout|null>} */
  const pollTimerRef = useRef(null);

  /**
   * Loads executions from the admin API with current filter parameters.
   * Updates state with the response data.
   *
   * @param {boolean} [showLoadingSpinner=false] - Whether to show the full loading spinner
   */
  const loadExecutions = useCallback(
    async (showLoadingSpinner = false) => {
      try {
        if (showLoadingSpinner) {
          setLoading(true);
        }
        setError(null);

        const params = { status: statusFilter };
        if (searchTerm.trim()) {
          params.search = searchTerm.trim();
        }

        const data = await fetchAdminExecutions(params);

        setExecutions(Array.isArray(data.executions) ? data.executions : []);
        setStats(data.stats || null);
        setTotal(data.total || 0);
      } catch (err) {
        console.error('Error loading executions:', err);
        setError(err.message);
      } finally {
        if (showLoadingSpinner) {
          setLoading(false);
        }
      }
    },
    [statusFilter, searchTerm]
  );

  // Initial load and filter change
  useEffect(() => {
    loadExecutions(true);
  }, [loadExecutions]);

  // Auto-refresh polling
  useEffect(() => {
    if (autoRefresh) {
      pollTimerRef.current = setInterval(() => {
        loadExecutions(false);
      }, POLL_INTERVAL_MS);
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [autoRefresh, loadExecutions]);

  /**
   * Handles cancelling a workflow execution with confirmation dialog.
   *
   * @param {Event} e - Click event
   * @param {string} executionId - The ID of the execution to cancel
   */
  const handleCancel = async (e, executionId) => {
    e.stopPropagation();

    const confirmed = window.confirm(
      t('admin.workflowExecutions.cancelConfirm', 'Are you sure you want to cancel this execution?')
    );
    if (!confirmed) return;

    try {
      setCancellingId(executionId);
      await cancelAdminExecution(executionId);
      // Refresh the list after cancellation
      await loadExecutions(false);
    } catch (err) {
      console.error('Error cancelling execution:', err);
      setError(
        t('admin.workflowExecutions.cancelError', 'Failed to cancel execution: {{message}}', {
          message: err.message
        })
      );
    } finally {
      setCancellingId(null);
    }
  };

  /**
   * Navigates to the execution detail/inspection page.
   *
   * @param {string} executionId - The execution ID to inspect
   */
  const handleInspect = executionId => {
    navigate(`/workflows/executions/${executionId}`);
  };

  /**
   * Resolves a localized workflow name from the workflowName object.
   *
   * @param {Object|string} workflowName - Localized name object or string
   * @returns {string} The resolved display name
   */
  const resolveWorkflowName = workflowName => {
    if (!workflowName) return '-';
    if (typeof workflowName === 'string') return workflowName;
    return getLocalizedContent(workflowName, currentLanguage) || '-';
  };

  /**
   * Determines whether a given execution can be cancelled.
   * Only running or paused executions are cancellable.
   *
   * @param {Object} execution - The execution object
   * @returns {boolean} True if the execution can be cancelled
   */
  const isCancellable = execution => {
    return execution.status === 'running' || execution.status === 'paused';
  };

  /**
   * Formats an ISO timestamp to a localized date-time string.
   *
   * @param {string} isoString - ISO timestamp string
   * @returns {string} Formatted date-time string
   */
  const formatDateTime = isoString => {
    if (!isoString) return '-';
    try {
      return new Date(isoString).toLocaleString();
    } catch {
      return isoString;
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="sm:flex sm:items-center sm:justify-between">
            <div className="sm:flex-auto">
              <div className="flex items-center gap-3 mb-1">
                <button
                  onClick={() => navigate('/admin/workflows')}
                  className="text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 flex items-center gap-1"
                >
                  <Icon name="arrow-left" className="h-4 w-4" />
                  {t('admin.workflowExecutions.backToWorkflows', 'Back to Workflows')}
                </button>
              </div>
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
                {t('admin.workflowExecutions.title', 'Workflow Executions')}
              </h1>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                {t(
                  'admin.workflowExecutions.subtitle',
                  'Monitor and manage workflow executions across all users.'
                )}
              </p>
            </div>

            {/* Auto-refresh toggle */}
            <div className="mt-4 sm:mt-0 sm:ml-4 flex items-center gap-3">
              {stats && (
                <div className="text-sm text-gray-500 dark:text-gray-400 hidden sm:block">
                  {t('admin.workflowExecutions.totalCount', '{{count}} total', { count: total })}
                </div>
              )}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  {t('admin.workflowExecutions.autoRefresh', 'Auto-refresh')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoRefresh}
                  onClick={() => setAutoRefresh(prev => !prev)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                    autoRefresh ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      autoRefresh ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </label>
              <button
                onClick={() => loadExecutions(false)}
                className="inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
                title={t('admin.workflowExecutions.refresh', 'Refresh')}
              >
                <Icon name="refresh" className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
              <div className="flex">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                <div className="ml-3">
                  <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
                  <button
                    onClick={() => {
                      setError(null);
                      loadExecutions(true);
                    }}
                    className="mt-1 text-sm text-red-600 dark:text-red-400 hover:text-red-500 underline"
                  >
                    {t('common.retry', 'Retry')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Stats summary */}
          {stats && stats.byStatus && (
            <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
              {['running', 'paused', 'completed', 'failed', 'cancelled', 'pending'].map(status => {
                const badgeClasses = getStatusBadgeClasses(status);
                const count = stats.byStatus[status] || 0;
                return (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(statusFilter === status ? 'all' : status)}
                    className={`rounded-lg p-3 text-center transition-all ${
                      statusFilter === status
                        ? 'ring-2 ring-indigo-500 shadow-md'
                        : 'hover:shadow-sm'
                    } ${badgeClasses.bg}`}
                  >
                    <div className={`text-2xl font-bold ${badgeClasses.text}`}>{count}</div>
                    <div className={`text-xs font-medium capitalize ${badgeClasses.text}`}>
                      {t(`admin.workflowExecutions.status.${status}`, status)}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Filter bar */}
          <div className="mt-6 flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Icon name="search" className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md leading-5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  placeholder={t(
                    'admin.workflowExecutions.searchPlaceholder',
                    'Search by user or workflow name...'
                  )}
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
            <div className="sm:w-48">
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              >
                <option value="all">
                  {t('admin.workflowExecutions.filterAll', 'All Statuses')}
                </option>
                <option value="running">
                  {t('admin.workflowExecutions.status.running', 'Running')}
                </option>
                <option value="paused">
                  {t('admin.workflowExecutions.status.paused', 'Paused')}
                </option>
                <option value="completed">
                  {t('admin.workflowExecutions.status.completed', 'Completed')}
                </option>
                <option value="failed">
                  {t('admin.workflowExecutions.status.failed', 'Failed')}
                </option>
                <option value="cancelled">
                  {t('admin.workflowExecutions.status.cancelled', 'Cancelled')}
                </option>
              </select>
            </div>
          </div>

          {/* Executions Table */}
          <div className="mt-6 flex flex-col">
            <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
              <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
                <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 dark:ring-gray-700 md:rounded-lg">
                  <table className="min-w-full divide-y divide-gray-300 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.workflowExecutions.table.executionId', 'Execution ID')}
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.workflowExecutions.table.workflow', 'Workflow')}
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.workflowExecutions.table.user', 'User')}
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.workflowExecutions.table.status', 'Status')}
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.workflowExecutions.table.startedAt', 'Started At')}
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.workflowExecutions.table.duration', 'Duration')}
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.workflowExecutions.table.currentNode', 'Current Node')}
                        </th>
                        <th scope="col" className="relative px-4 py-3">
                          <span className="sr-only">
                            {t('admin.workflowExecutions.table.actions', 'Actions')}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                      {executions.map(execution => {
                        const badgeClasses = getStatusBadgeClasses(execution.status);
                        return (
                          <tr
                            key={execution.executionId}
                            className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                            onClick={() => handleInspect(execution.executionId)}
                          >
                            <td className="px-4 py-3 whitespace-nowrap">
                              <code className="text-xs font-mono text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
                                {shortenId(execution.executionId)}
                              </code>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="text-sm font-medium text-gray-900 dark:text-white">
                                {resolveWorkflowName(execution.workflowName)}
                              </div>
                              <div
                                className="text-xs text-gray-500 dark:text-gray-400 max-w-[10rem] truncate"
                                title={execution.workflowId || '-'}
                              >
                                {execution.workflowId || '-'}
                              </div>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div
                                className="text-sm text-gray-900 dark:text-gray-200 max-w-[12rem] truncate"
                                title={execution.userId || '-'}
                              >
                                {execution.userId || '-'}
                              </div>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${badgeClasses.bg} ${badgeClasses.text}`}
                              >
                                {execution.status === 'running' && (
                                  <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                                )}
                                {t(
                                  `admin.workflowExecutions.status.${execution.status}`,
                                  execution.status
                                )}
                              </span>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                              {formatDateTime(execution.startedAt)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                              {computeDuration(execution.startedAt, execution.completedAt)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {execution.currentNode ? (
                                <code
                                  className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded max-w-[8rem] truncate inline-block"
                                  title={execution.currentNode}
                                >
                                  {execution.currentNode}
                                </code>
                              ) : (
                                <span className="text-sm text-gray-400">-</span>
                              )}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={e => {
                                    e.stopPropagation();
                                    handleInspect(execution.executionId);
                                  }}
                                  className="p-2 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-full"
                                  title={t('admin.workflowExecutions.inspect', 'View / Inspect')}
                                >
                                  <Icon name="eye" className="h-4 w-4" />
                                </button>
                                {isCancellable(execution) && (
                                  <button
                                    onClick={e => handleCancel(e, execution.executionId)}
                                    disabled={cancellingId === execution.executionId}
                                    className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-full disabled:opacity-50 disabled:cursor-not-allowed"
                                    title={t('admin.workflowExecutions.cancel', 'Cancel Execution')}
                                  >
                                    {cancellingId === execution.executionId ? (
                                      <Icon name="refresh" className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <Icon name="x-circle" className="h-4 w-4" />
                                    )}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {executions.length === 0 && !loading && (
                    <div className="text-center py-12 bg-gray-50 dark:bg-gray-800">
                      <Icon name="play" className="mx-auto h-12 w-12 text-gray-400" />
                      <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                        {t('admin.workflowExecutions.noExecutions', 'No executions found')}
                      </h3>
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        {statusFilter !== 'all'
                          ? t(
                              'admin.workflowExecutions.noExecutionsFiltered',
                              'No executions match the current filters. Try adjusting your search criteria.'
                            )
                          : t(
                              'admin.workflowExecutions.noExecutionsYet',
                              'No workflow executions have been recorded yet.'
                            )}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminWorkflowExecutionsPage;
