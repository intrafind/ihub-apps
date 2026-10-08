import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../api/adminApi';
import { formatBytes, formatPercent } from '../utils/systemResourcesFormat';

/** How often the banner re-checks while an admin page is open. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * sessionStorage key holding the status the admin dismissed. A dismissed
 * warning comes back when the disk turns critical; a dismissed critical stays
 * hidden until the browser session ends.
 */
const DISMISS_KEY = 'ihub.admin.storageAlertDismissed';

function readDismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(status) {
  try {
    sessionStorage.setItem(DISMISS_KEY, status);
  } catch {
    // Private mode or blocked storage: the banner simply comes back.
  }
}

/**
 * Low-disk banner shown above every admin page while a volume iHub writes to
 * is at the warning or critical threshold. A full disk breaks saving chats,
 * uploads and configuration, so it has to be seen wherever the admin is, not
 * only on the Overview.
 *
 * @param {object} props
 * @param {boolean} [props.enabled=true] - Fetch at all (false for content
 *   admins, who may not call the endpoint).
 * @param {boolean} [props.linkVisible=true] - Link to the System Resources
 *   page (false when system pages are disabled).
 * @param {boolean} [props.hidden=false] - Render nothing, e.g. on the System
 *   Resources page, which shows its own, more detailed alert.
 */
export default function AdminStorageAlert({ enabled = true, linkVisible = true, hidden = false }) {
  const { t } = useTranslation();
  const [storage, setStorage] = useState(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await makeAdminApiCall('/admin/system/storage');
        if (!cancelled) setStorage(response.data?.storage ?? null);
      } catch {
        // Best effort: without an answer there is nothing to warn about.
      }
    };
    void load();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  const status = storage?.status;
  if (hidden || (status !== 'warning' && status !== 'critical') || dismissed === status) {
    return null;
  }

  const critical = status === 'critical';
  const params = {
    free: formatBytes(storage.available),
    percent: formatPercent(storage.usedPercent)
  };

  const dismiss = () => {
    writeDismissed(status);
    setDismissed(status);
  };

  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-4">
      <div
        role="alert"
        className={`max-w-5xl mx-auto flex flex-wrap items-center gap-3 p-4 rounded-lg border ${
          critical
            ? 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
            : 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
        }`}
      >
        <ExclamationTriangleIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
        <p className="text-sm flex-1 min-w-0">
          {critical
            ? t(
                'admin.storageAlert.critical',
                'Disk space is critically low: {{free}} free ({{percent}} used).',
                params
              )
            : t(
                'admin.storageAlert.warning',
                'Disk space is running low: {{free}} free ({{percent}} used).',
                params
              )}
        </p>
        {linkVisible && (
          <Link
            to="/admin/system-resources"
            className="text-sm font-medium underline hover:no-underline inline-flex items-center gap-1"
          >
            {t('admin.storageAlert.viewDetails', 'View system resources')}
            <ArrowRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="p-1 -m-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={t('admin.storageAlert.dismiss', 'Dismiss')}
        >
          <XMarkIcon className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
