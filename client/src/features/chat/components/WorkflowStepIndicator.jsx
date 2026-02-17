import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Unified workflow progress component for chat messages.
 *
 * While running: shows a compact bar with spinner + current step name + step count,
 *   expandable to full step timeline.
 * On completion: shows an attribution line ("Generated via workflowName"),
 *   expandable to full step timeline.
 * On failure: shows a failure attribution line, expandable to see where it failed.
 *
 * Filters out start/end node types and steps with chatVisible === false.
 *
 * @param {Object} props
 * @param {Array}  props.steps       - Full step history array
 * @param {Object} [props.currentStep] - Currently running step (null when done)
 * @param {Object} [props.result]    - Completion result (null while running)
 * @param {boolean} props.loading    - Whether workflow is still in progress
 */
const WorkflowStepIndicator = ({ steps = [], currentStep, result, loading }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Filter out start/end nodes and chatVisible === false steps
  const visibleSteps = steps.filter(
    s => s.nodeType !== 'start' && s.nodeType !== 'end' && s.chatVisible !== false
  );

  // Nothing to show
  if (visibleSteps.length === 0 && !loading && !result) return null;

  const workflowName =
    result?.workflowName || currentStep?.workflowName || visibleSteps[0]?.workflowName || '';

  // Determine the latest running step for the compact view
  const latestStep = visibleSteps.length > 0 ? visibleSteps[visibleSteps.length - 1] : null;
  // -- RUNNING STATE --
  if (loading) {
    return (
      <div className="mb-2 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full text-left"
        >
          <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-blue-400 border-t-transparent flex-shrink-0" />
          <span className="font-medium text-blue-600 dark:text-blue-400 truncate flex-1">
            {latestStep?.nodeName || t('workflow.running', 'Running workflow...')}
          </span>
          {visibleSteps.length > 0 && (
            <span className="text-gray-400 dark:text-gray-500 flex-shrink-0">
              {visibleSteps.length} {visibleSteps.length === 1 ? 'step' : 'steps'}
            </span>
          )}
          {visibleSteps.length > 0 && (
            <Icon
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size="xs"
              className="flex-shrink-0"
            />
          )}
        </button>
        {expanded && visibleSteps.length > 0 && (
          <div className="mt-1.5 space-y-0.5 border-t border-blue-100 dark:border-blue-900 pt-1.5">
            {visibleSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-1.5">
                {step.status === 'completed' && (
                  <Icon name="check" size="xs" className="text-green-500 flex-shrink-0" />
                )}
                {step.status === 'running' && (
                  <div className="animate-spin rounded-full h-2.5 w-2.5 border-2 border-blue-400 border-t-transparent flex-shrink-0" />
                )}
                {step.status === 'error' && (
                  <Icon
                    name="exclamation-circle"
                    size="xs"
                    className="text-red-500 flex-shrink-0"
                  />
                )}
                {!['completed', 'running', 'error'].includes(step.status) && (
                  <div className="h-2.5 w-2.5 rounded-full bg-gray-300 dark:bg-gray-600 flex-shrink-0" />
                )}
                <span
                  className={
                    step.status === 'running' ? 'font-medium text-blue-600 dark:text-blue-400' : ''
                  }
                >
                  {step.nodeName || t('workflow.unknownStep', 'Step')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // -- COMPLETED / FAILED STATE --
  if (result) {
    const isFailed = result.status === 'failed';

    return (
      <div className="mt-2 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full text-left"
        >
          <Icon
            name={isFailed ? 'exclamation-circle' : 'cog'}
            size="xs"
            className={`flex-shrink-0 ${isFailed ? 'text-red-500' : ''}`}
          />
          <span className="font-medium">
            {isFailed ? t('workflow.failed', 'Failed') : t('workflow.generated', 'Generated')}
            {' via '}
            <span className="text-gray-700 dark:text-gray-300">{workflowName || 'workflow'}</span>
          </span>
          {visibleSteps.length > 0 && (
            <Icon
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size="xs"
              className="ml-auto flex-shrink-0"
            />
          )}
        </button>
        {expanded && visibleSteps.length > 0 && (
          <div className="mt-1.5 space-y-0.5 border-t border-gray-100 dark:border-gray-700 pt-1.5">
            {visibleSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-1.5">
                {step.status === 'completed' && (
                  <Icon name="check" size="xs" className="text-green-500 flex-shrink-0" />
                )}
                {step.status === 'error' && (
                  <Icon
                    name="exclamation-circle"
                    size="xs"
                    className="text-red-500 flex-shrink-0"
                  />
                )}
                {!['completed', 'error'].includes(step.status) && (
                  <div className="h-2.5 w-2.5 rounded-full bg-gray-300 dark:bg-gray-600 flex-shrink-0" />
                )}
                <span>{step.nodeName || t('workflow.unknownStep', 'Step')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Fallback: steps exist but no result and not loading (edge case)
  return null;
};

export default WorkflowStepIndicator;
