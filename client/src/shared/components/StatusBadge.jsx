const STATUS_COLORS = {
  queued: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  building: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  cancelled: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
};

export default function StatusBadge({ status, className = '' }) {
  return (
    <span
      className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[status] || STATUS_COLORS.queued} ${className}`}
    >
      {status}
    </span>
  );
}
