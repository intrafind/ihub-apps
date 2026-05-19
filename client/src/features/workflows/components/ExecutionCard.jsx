import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import StatusBadge from './StatusBadge';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Renders the sanitized input preview captured at workflow start time.
 * Falls back to `null` when the execution has no input metadata.
 */
function InputPreview({ inputPreview, t }) {
  if (!inputPreview || typeof inputPreview !== 'object') return null;

  const entries = Object.entries(inputPreview).filter(([key]) => key !== '__more');
  if (entries.length === 0) return null;

  const more = typeof inputPreview.__more === 'number' ? inputPreview.__more : 0;
  const parts = entries.map(([key, value]) => `${key}: ${value}`);
  if (more > 0)
    parts.push(t('workflows.executionCard.moreInputs', '+{{count}} more', { count: more }));

  return (
    <div className="mt-1 text-sm text-gray-600 dark:text-gray-300 line-clamp-2 break-words">
      <span className="font-medium">{t('workflows.executionCard.inputLabel', 'Input')}:</span>{' '}
      {parts.join(' · ')}
    </div>
  );
}

/**
 * Renders the model badge (if any models were derived from the workflow).
 */
function ModelBadge({ models }) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const label = models.length > 1 ? `${models[0]} +${models.length - 1}` : models[0];
  return (
    <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
      {label}
    </span>
  );
}

/**
 * Card component displaying a workflow execution.
 *
 * @param {Object} props - Component props
 * @param {Object} props.execution - Execution metadata object
 * @param {Function} props.onJoin - Callback when join/view button is clicked
 * @param {Function} [props.onDelete] - Callback when delete is requested
 * @param {Function} [props.onArchive] - Callback (execution, nextArchived) when archive toggled
 * @param {Function} [props.onDownload] - Callback when download is requested
 */
function ExecutionCard({ execution, onJoin, onDelete, onArchive, onDownload }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;

  const workflowName =
    getLocalizedContent(execution.workflowName, currentLanguage) || execution.workflowId;

  const startedAt = execution.startedAt
    ? new Date(execution.startedAt).toLocaleString(currentLanguage)
    : '';

  const hasPendingCheckpoint = !!execution.pendingCheckpoint;
  const isActive = execution.status === 'running' || execution.status === 'paused';
  const isRunning = execution.status === 'running';
  const isArchived = execution.archived === true;
  const canDownload = TERMINAL_STATES.has(execution.status);
  const canDelete = !isRunning;

  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 overflow-hidden border-l-4 ${
        isArchived ? 'opacity-60' : ''
      }`}
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
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="font-semibold text-gray-900 dark:text-white truncate">
                {workflowName}
              </h3>
              <StatusBadge status={execution.status} />
              {isArchived && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200">
                  {t('workflows.executionCard.archived', 'Archived')}
                </span>
              )}
              <ModelBadge models={execution.models} />
            </div>

            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('workflows.executionCard.startedAt', 'Started')}: {startedAt}
            </p>

            <InputPreview inputPreview={execution.inputPreview} t={t} />

            {/* Current node indicator */}
            {execution.currentNode && isActive && (
              <div className="mt-1 text-sm text-gray-600 dark:text-gray-300 flex items-center gap-1">
                <Icon name="arrow-right" className="w-3 h-3" />
                {t('workflows.executionCard.current', 'Current')}: {execution.currentNode}
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

          {/* Right side: Action icons + Join/View */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {onDownload && (
              <button
                type="button"
                onClick={() => canDownload && onDownload(execution)}
                disabled={!canDownload}
                className={`p-2 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                  canDownload
                    ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700'
                    : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                }`}
                title={
                  canDownload
                    ? t('workflows.executionCard.download', 'Download result')
                    : t('workflows.executionCard.downloadDisabled', 'Available when finished')
                }
                aria-label={t('workflows.executionCard.download', 'Download result')}
              >
                <Icon name="download" className="w-4 h-4" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => canDelete && onDelete(execution)}
                disabled={!canDelete}
                className={`p-2 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 ${
                  canDelete
                    ? 'text-gray-500 hover:text-red-600 hover:bg-red-50 dark:text-gray-400 dark:hover:text-red-400 dark:hover:bg-red-900/20'
                    : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                }`}
                title={
                  canDelete
                    ? t('workflows.executionCard.delete', 'Delete execution')
                    : t(
                        'workflows.executionCard.deleteDisabled',
                        'Cancel the workflow before deleting'
                      )
                }
                aria-label={t('workflows.executionCard.delete', 'Delete execution')}
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            )}
            {onArchive && (
              <button
                type="button"
                onClick={() => onArchive(execution, !isArchived)}
                className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
                title={
                  isArchived
                    ? t('workflows.executionCard.unarchive', 'Unarchive')
                    : t('workflows.executionCard.archive', 'Archive')
                }
                aria-label={
                  isArchived
                    ? t('workflows.executionCard.unarchive', 'Unarchive')
                    : t('workflows.executionCard.archive', 'Archive')
                }
              >
                <Icon name="archive-box" className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => onJoin(execution)}
              className={`ml-1 inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
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
