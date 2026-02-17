import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';

/**
 * Status badge component
 */
function StatusBadge({ status }) {
  const statusConfig = {
    pending: { bg: 'bg-gray-100', text: 'text-gray-800', icon: 'clock' },
    running: { bg: 'bg-blue-100', text: 'text-blue-800', icon: 'arrow-path', animate: true },
    paused: { bg: 'bg-yellow-100', text: 'text-yellow-800', icon: 'pause' },
    completed: { bg: 'bg-green-100', text: 'text-green-800', icon: 'check-circle' },
    failed: { bg: 'bg-red-100', text: 'text-red-800', icon: 'x-circle' },
    cancelled: { bg: 'bg-gray-100', text: 'text-gray-800', icon: 'x-mark' }
  };

  const config = statusConfig[status] || statusConfig.pending;

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}
    >
      <Icon name={config.icon} className={`w-3 h-3 mr-1 ${config.animate ? 'animate-spin' : ''}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

/**
 * Card component displaying a workflow execution.
 *
 * @param {Object} props - Component props
 * @param {Object} props.execution - Execution metadata object
 * @param {Function} props.onJoin - Callback when join/view button is clicked
 */
function ExecutionCard({ execution, onJoin }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;

  const workflowName =
    getLocalizedContent(execution.workflowName, currentLanguage) || execution.workflowId;

  const startedAt = execution.startedAt
    ? new Date(execution.startedAt).toLocaleString(currentLanguage)
    : '';

  const hasPendingCheckpoint = !!execution.pendingCheckpoint;
  const isActive = execution.status === 'running' || execution.status === 'paused';

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 overflow-hidden border-l-4"
      style={{
        borderLeftColor:
          execution.status === 'running'
            ? '#3B82F6'
            : execution.status === 'paused'
              ? '#F59E0B'
              : execution.status === 'completed'
                ? '#10B981'
                : execution.status === 'failed'
                  ? '#EF4444'
                  : '#6B7280'
      }}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          {/* Left side: Workflow info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-gray-900 dark:text-white truncate">
                {workflowName}
              </h3>
              <StatusBadge status={execution.status} />
            </div>

            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Started: {startedAt}</p>

            {/* Current node indicator */}
            {execution.currentNode && isActive && (
              <div className="text-sm text-gray-600 dark:text-gray-300 flex items-center gap-1">
                <Icon name="arrow-right" className="w-3 h-3" />
                Current: {execution.currentNode}
              </div>
            )}

            {/* Pending checkpoint indicator */}
            {hasPendingCheckpoint && (
              <div className="mt-2 flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
                <Icon name="hand-raised" className="w-4 h-4" />
                <span className="text-sm font-medium">
                  {t('workflows.checkpointAwaiting', 'Awaiting your input')}
                </span>
              </div>
            )}
          </div>

          {/* Right side: Action button */}
          <div className="flex-shrink-0">
            <button
              onClick={() => onJoin(execution)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                isActive
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200'
              }`}
            >
              <Icon name={isActive ? 'eye' : 'document-text'} className="w-4 h-4" />
              {isActive ? t('workflows.join', 'Join') : t('workflows.view', 'View')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ExecutionCard;
