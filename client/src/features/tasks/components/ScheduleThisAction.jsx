import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useCanCreateScheduledTasks, useScheduledTasksAvailable } from '../hooks/useScheduledTasks';

function ScheduleThisButton({ content, appId, enabledTools }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        navigate('/tasks/new', {
          state: {
            draft: {
              name: String(content || '')
                .trim()
                .split('\n')[0]
                .slice(0, 80),
              instructions: content,
              ...(appId ? { appId } : {}),
              ...(Array.isArray(enabledTools) ? { enabledTools } : {})
            }
          }
        })
      }
      className="flex items-center gap-1 hover:text-indigo-600 transition-colors duration-150"
      title={t('scheduledTasks.scheduleThis', 'Schedule this…')}
      aria-label={t('scheduledTasks.scheduleThis', 'Schedule this…')}
    >
      <Icon name="calendar" size="sm" />
    </button>
  );
}

/**
 * "Schedule this…" on a sent message: opens the task form pre-filled with
 * the message, the current app and its tools. Renders nothing (and touches no
 * router) unless scheduled tasks are available to the viewer.
 */
export default function ScheduleThisAction(props) {
  const available = useScheduledTasksAvailable();
  const canCreate = useCanCreateScheduledTasks();
  if (!available || !canCreate || !props.content) return null;
  return <ScheduleThisButton {...props} />;
}
