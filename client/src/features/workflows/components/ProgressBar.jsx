import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Horizontal progress bar for an executing workflow.
 *
 * Step counting is best-effort because workflows can include loops, branches,
 * and conditionally-skipped nodes. We use `completedNodes.length` over the
 * total node count from the workflow definition; the displayed total is
 * prefixed with `~` to signal it's an approximation.
 *
 * Time remaining is intentionally NOT shown. Workflows have no historical
 * duration data, so any estimate would be misleading.
 *
 * @param {Object} props
 * @param {string} props.status
 * @param {number} props.completedCount
 * @param {number} props.totalCount
 * @param {string} [props.elapsedFormatted]
 */
function ProgressBar({ status, completedCount, totalCount, elapsedFormatted }) {
  const { t } = useTranslation();

  const { percent, barColor } = useMemo(() => {
    const safeTotal = Math.max(totalCount || 0, 1);
    const safeCompleted = Math.max(0, Math.min(completedCount || 0, safeTotal));
    let pct = (safeCompleted / safeTotal) * 100;

    // For terminal states with no completed-count signal, show full bar.
    if (status === 'completed' || status === 'approved') pct = 100;

    let color = 'bg-indigo-600';
    if (status === 'failed') color = 'bg-red-500';
    else if (status === 'cancelled' || status === 'rejected') color = 'bg-gray-400';
    else if (status === 'completed' || status === 'approved') color = 'bg-green-500';
    else if (status === 'paused') color = 'bg-yellow-500';

    return { percent: pct, barColor: color };
  }, [completedCount, totalCount, status]);

  const showApproxMarker = totalCount > 0;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-sm mb-1.5">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
          {showApproxMarker && (
            <span
              title={t(
                'workflows.stepCounterApproxTooltip',
                'Total step count is approximate. Workflows may include loops, branches, or skipped steps.'
              )}
            >
              {t('workflows.stepCounter', 'Step {{current}} of ~{{total}}', {
                current: completedCount,
                total: totalCount
              })}
            </span>
          )}
        </div>
        {elapsedFormatted && (
          <span
            className="text-gray-500 dark:text-gray-400 flex items-center gap-1"
            aria-label={`Elapsed time ${elapsedFormatted}`}
          >
            <Icon name="clock" className="w-3.5 h-3.5" aria-hidden="true" />
            {elapsedFormatted}
          </span>
        )}
      </div>
      <div
        className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('workflows.progress.title', 'Execution Progress')}
      >
        <div
          className={`h-full ${barColor} transition-all duration-500 ease-out`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export default ProgressBar;
