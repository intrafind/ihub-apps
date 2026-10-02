import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../api/adminApi';

/** sessionStorage key: set when the admin dismissed the banner for this browser session. */
const DISMISS_KEY = 'ihub.admin.demoAccountsAlertDismissed';

function readDismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    sessionStorage.setItem(DISMISS_KEY, 'true');
  } catch {
    // Private mode or blocked storage: the banner simply comes back.
  }
}

/**
 * Banner shown above every admin page while the login page lists the demo
 * accounts (`localAuth.showDemoAccounts`) and one of them still has the
 * password it ships with. Anyone who opens the login page can then sign in
 * with it, so the admin should see this wherever they are. It is checked again
 * on every admin page change, so it goes away once the setting or the
 * passwords have been changed.
 *
 * @param {object} props
 * @param {boolean} [props.enabled=true] - Fetch at all (false for content
 *   admins, who may not call the endpoint).
 * @param {boolean} [props.authLinkVisible=true] - Link to Admin → Authentication.
 * @param {boolean} [props.usersLinkVisible=true] - Link to Admin → Users.
 */
export default function AdminDemoAccountsAlert({
  enabled = true,
  authLinkVisible = true,
  usersLinkVisible = true
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (!enabled || dismissed) return undefined;
    let cancelled = false;
    makeAdminApiCall('/admin/auth/demo-accounts')
      .then(response => {
        if (!cancelled) setStatus(response.data ?? null);
      })
      .catch(() => {
        // Best effort: without an answer there is nothing to warn about.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, dismissed, pathname]);

  // `enabled` can turn false after a fetch (e.g. the user is now a content admin only).
  if (!enabled || !status?.warn || dismissed) return null;

  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
  };

  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-4">
      <div
        role="alert"
        className="max-w-5xl mx-auto flex flex-wrap items-center gap-3 p-4 rounded-lg border bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200"
      >
        <ExclamationTriangleIcon className="w-5 h-5 shrink-0" aria-hidden="true" />
        <p className="text-sm flex-1 min-w-0">
          {t(
            'admin.demoAccountsAlert.message',
            'The login page shows the demo accounts, and {{accounts}} still use the password they ship with. Anyone who opens the login page can sign in with them. Turn off "Show Demo Accounts in Login Form" or change their passwords.',
            { accounts: status.accounts.join(', ') }
          )}
        </p>
        {authLinkVisible && (
          <Link
            to="/admin/auth"
            className="text-sm font-medium underline hover:no-underline inline-flex items-center gap-1"
          >
            {t('admin.demoAccountsAlert.authSettings', 'Authentication settings')}
            <ArrowRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
        )}
        {usersLinkVisible && (
          <Link
            to="/admin/users"
            className="text-sm font-medium underline hover:no-underline inline-flex items-center gap-1"
          >
            {t('admin.demoAccountsAlert.users', 'Users')}
            <ArrowRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="p-1 -m-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={t('admin.demoAccountsAlert.dismiss', 'Dismiss')}
        >
          <XMarkIcon className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
