import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Maps workflow execution status to a visual treatment.
 * Every entry includes both an icon and explicit text so the status is not
 * conveyed by color alone (a11y).
 */
const STATUS_CONFIG = {
  pending: {
    bg: 'bg-gray-100 dark:bg-gray-700',
    text: 'text-gray-700 dark:text-gray-200',
    icon: 'clock'
  },
  running: {
    bg: 'bg-blue-100 dark:bg-blue-900/40',
    text: 'text-blue-800 dark:text-blue-200',
    icon: 'arrow-path',
    animate: true
  },
  paused: {
    bg: 'bg-yellow-100 dark:bg-yellow-900/40',
    text: 'text-yellow-800 dark:text-yellow-200',
    icon: 'pause'
  },
  completed: {
    bg: 'bg-green-100 dark:bg-green-900/40',
    text: 'text-green-800 dark:text-green-200',
    icon: 'check-circle'
  },
  approved: {
    bg: 'bg-green-100 dark:bg-green-900/40',
    text: 'text-green-800 dark:text-green-200',
    icon: 'check-circle'
  },
  rejected: {
    bg: 'bg-orange-100 dark:bg-orange-900/40',
    text: 'text-orange-800 dark:text-orange-200',
    icon: 'x-circle'
  },
  failed: {
    bg: 'bg-red-100 dark:bg-red-900/40',
    text: 'text-red-800 dark:text-red-200',
    icon: 'x-circle'
  },
  cancelled: {
    bg: 'bg-gray-100 dark:bg-gray-700',
    text: 'text-gray-700 dark:text-gray-200',
    icon: 'stop-circle'
  }
};

/**
 * Status pill for workflow executions. Reusable across cards, headers,
 * and progress lists. When `live` is true, sets `role="status"` and
 * `aria-live="polite"` so screen readers announce status changes — use
 * this on the SINGLE status pill that represents the current state of the
 * page (typically the execution header).
 *
 * @param {Object} props
 * @param {string} props.status
 * @param {boolean} [props.live=false]
 * @param {string} [props.className]
 */
function StatusBadge({ status, live = false, className = '' }) {
  const { t } = useTranslation();
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const label = t(
    `workflows.statusLabel.${status}`,
    status.charAt(0).toUpperCase() + status.slice(1)
  );

  const liveProps = live ? { role: 'status', 'aria-live': 'polite' } : {};

  return (
    <span
      {...liveProps}
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text} ${className}`}
    >
      <Icon
        name={config.icon}
        className={`w-3 h-3 mr-1 ${config.animate ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

export default StatusBadge;
