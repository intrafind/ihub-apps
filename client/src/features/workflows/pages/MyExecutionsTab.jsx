import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMyExecutions } from '../hooks';
import { ExecutionCard } from '../components';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';

/**
 * Tab content showing the user's workflow executions.
 *
 * @param {Object} props
 * @param {() => void} [props.onBrowseWorkflows] - Optional callback invoked when
 *   the user clicks the empty-state "Browse workflows" CTA. The parent decides
 *   how to navigate (typically by switching tabs).
 */
function MyExecutionsTab({ onBrowseWorkflows }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('all');

  const { executions, loading, error, refetch, runningCount } = useMyExecutions({
    status: statusFilter === 'all' ? undefined : statusFilter
  });

  // Auto-refresh when there are running executions
  useEffect(() => {
    if (runningCount > 0) {
      const interval = setInterval(refetch, 5000);
      return () => clearInterval(interval);
    }
  }, [runningCount, refetch]);

  const handleJoin = execution => {
    navigate(`/workflows/executions/${execution.executionId}`);
  };

  const statusFilters = [
    { value: 'all', label: t('workflows.filter.all', 'All') },
    { value: 'running', label: t('workflows.filter.running', 'Running') },
    { value: 'paused', label: t('workflows.filter.paused', 'Paused') },
    { value: 'completed', label: t('workflows.filter.completed', 'Completed') },
    { value: 'failed', label: t('workflows.filter.failed', 'Failed') }
  ];

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <LoadingSpinner message={t('workflows.loadingExecutions', 'Loading executions...')} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          onClick={refetch}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
        >
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 mb-6">
        {statusFilters.map(filter => (
          <button
            key={filter.value}
            onClick={() => setStatusFilter(filter.value)}
            aria-pressed={statusFilter === filter.value}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 ${
              statusFilter === filter.value
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {filter.label}
            {filter.value === 'running' && runningCount > 0 && (
              <span
                className="ml-2 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full"
                aria-label={`${runningCount} running`}
              >
                {runningCount}
              </span>
            )}
          </button>
        ))}

        {/* Refresh button */}
        <button
          onClick={refetch}
          className="ml-auto px-3 py-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-lg"
          title={t('common.refresh', 'Refresh')}
          aria-label={t('common.refresh', 'Refresh')}
        >
          <Icon name="arrow-path" className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      {/* Executions list */}
      {executions.length === 0 ? (
        <div className="text-center py-12">
          <Icon
            name="inbox"
            className="w-16 h-16 mx-auto text-gray-300 dark:text-gray-600 mb-4"
            aria-hidden="true"
          />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            {statusFilter === 'all'
              ? t('workflows.emptyState.executions.title', "You haven't run a workflow yet")
              : t('workflows.emptyState.executions.filteredTitle', 'No {{status}} runs', {
                  status: statusFilter
                })}
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4 max-w-md mx-auto">
            {statusFilter === 'all'
              ? t(
                  'workflows.emptyState.executions.body',
                  'Pick one from the Available tab to get started.'
                )
              : t('workflows.emptyState.executions.filteredBody', 'Try a different filter.')}
          </p>
          {statusFilter === 'all' && onBrowseWorkflows && (
            <button
              type="button"
              onClick={onBrowseWorkflows}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <Icon name="squares-2x2" className="w-4 h-4" aria-hidden="true" />
              {t('workflows.emptyState.executions.cta', 'Browse workflows')}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {executions.map(execution => (
            <ExecutionCard key={execution.executionId} execution={execution} onJoin={handleJoin} />
          ))}
        </div>
      )}
    </div>
  );
}

export default MyExecutionsTab;
