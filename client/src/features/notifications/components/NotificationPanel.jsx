import { useTranslation } from 'react-i18next';

function relativeTime(isoString, t) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return t('notifications.justNow', 'Just now');
  if (diffMin < 60) return t('notifications.minutesAgo', '{{count}}m ago', { count: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return t('notifications.hoursAgo', '{{count}}h ago', { count: diffHr });
  const diffDay = Math.round(diffHr / 24);
  return t('notifications.daysAgo', '{{count}}d ago', { count: diffDay });
}

function describeNotification(notification, t) {
  const toolType = notification.data?.toolType;
  switch (notification.type) {
    case 'job.completed':
      return t('notifications.jobCompleted', '{{toolType}} job completed', {
        toolType: toolType || t('notifications.job', 'Job')
      });
    case 'job.error':
      return t('notifications.jobError', '{{toolType}} job failed', {
        toolType: toolType || t('notifications.job', 'Job')
      });
    case 'job.cancelled':
      return t('notifications.jobCancelled', '{{toolType}} job cancelled', {
        toolType: toolType || t('notifications.job', 'Job')
      });
    default:
      return notification.type;
  }
}

export default function NotificationPanel({ notifications, onMarkRead, onMarkAllRead }) {
  const { t } = useTranslation();

  return (
    <div
      className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-50"
      role="dialog"
      aria-label={t('notifications.panelLabel', 'Notifications')}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <span className="font-medium text-gray-900 dark:text-gray-100">
          {t('notifications.title', 'Notifications')}
        </span>
        {notifications.length > 0 && (
          <button
            type="button"
            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            onClick={onMarkAllRead}
          >
            {t('notifications.markAllRead', 'Mark all read')}
          </button>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
          {t('notifications.empty', 'No notifications yet')}
        </div>
      ) : (
        <ul>
          {notifications.map(notification => (
            <li key={notification.id}>
              <button
                type="button"
                className={`w-full text-left px-4 py-3 text-sm border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-start gap-2 ${
                  notification.read ? 'opacity-60' : ''
                }`}
                onClick={() => {
                  if (!notification.read) onMarkRead(notification.id);
                }}
              >
                {!notification.read && (
                  <span className="mt-1.5 w-2 h-2 rounded-full bg-indigo-600 flex-shrink-0" />
                )}
                <span className="flex-1">
                  <span className="block text-gray-900 dark:text-gray-100">
                    {describeNotification(notification, t)}
                  </span>
                  <span className="block text-xs text-gray-400 dark:text-gray-500">
                    {relativeTime(notification.createdAt, t)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
