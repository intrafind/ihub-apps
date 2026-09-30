import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useScheduledTaskNotifications } from '../hooks/useScheduledTasks';
import { runChatLink } from '../utils/taskFormat';

const STORAGE_KEY = 'ihub.scheduledTasks.toastedRuns';
const MAX_REMEMBERED = 200;
const TOAST_MS = 12_000;

function readToasted() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function rememberToasted(ids) {
  try {
    const list = [...readToasted(), ...ids].slice(-MAX_REMEMBERED);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Private mode: the toast may show again next time, nothing worse.
  }
}

/**
 * A toast for scheduled runs that finished while the user was away — once
 * per run and browser, on the next page load (and when the slow poll finds
 * one). The runs stay listed as new on the Tasks page until their chat is
 * opened.
 */
export default function ScheduledTaskNotifier() {
  const { t } = useTranslation();
  const location = useLocation();
  const { items } = useScheduledTaskNotifications();
  const [toast, setToast] = useState([]);

  const fresh = useMemo(() => {
    const toasted = readToasted();
    return items.filter(item => !toasted.has(item.id));
    // `items` is the dependency; the stored set is read at compute time.
  }, [items]);

  useEffect(() => {
    if (fresh.length === 0) return undefined;
    // Not on the page that already lists them.
    if (location.pathname.startsWith('/tasks')) {
      rememberToasted(fresh.map(item => item.id));
      return undefined;
    }
    setToast(fresh.slice(0, 3));
    rememberToasted(fresh.map(item => item.id));
    const id = setTimeout(() => setToast([]), TOAST_MS);
    return () => clearTimeout(id);
  }, [fresh, location.pathname]);

  if (toast.length === 0) return null;

  const statusText = item => {
    if (item.status === 'failed') return t('scheduledTasks.toast.failed', 'failed');
    if (item.status === 'awaiting_approval') {
      return t('scheduledTasks.toast.awaitingApproval', 'needs your approval');
    }
    return t('scheduledTasks.toast.finished', 'finished');
  };

  return (
    <div
      className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] space-y-2"
      role="status"
      aria-live="polite"
    >
      {toast.map(item => {
        const chatLink = runChatLink(item.appId, item.chatId);
        return (
          <div
            key={item.id}
            className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-3 text-sm flex gap-3"
          >
            <Icon
              name={item.status === 'failed' ? 'exclamation-triangle' : 'calendar'}
              size="md"
              className={item.status === 'failed' ? 'text-red-500' : 'text-indigo-500'}
            />
            <div className="flex-1 min-w-0">
              <p className="text-gray-900 dark:text-gray-100">
                {t('scheduledTasks.toast.title', '"{{name}}" {{status}}', {
                  name: item.taskName,
                  status: statusText(item)
                })}
              </p>
              <div className="mt-1 flex gap-3">
                {chatLink && item.status !== 'awaiting_approval' && (
                  <Link
                    to={chatLink}
                    onClick={() => setToast([])}
                    className="text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    {t('scheduledTasks.openChat', 'Open chat')}
                  </Link>
                )}
                <Link
                  to={`/tasks/${item.taskId}`}
                  onClick={() => setToast([])}
                  className="text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {t('scheduledTasks.openTask', 'Open task')}
                </Link>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setToast(current => current.filter(entry => entry.id !== item.id))}
              aria-label={t('common.close', 'Close')}
              className="text-gray-400 hover:text-gray-600"
            >
              <Icon name="x" size="sm" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
