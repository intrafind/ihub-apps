// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import useFocusTrap from '../../../shared/hooks/useFocusTrap';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { CONFIG_CONFLICT_EVENT, revisionReadUrlOf } from '../../../api/adminConfigRevision';

const BUTTON_BASE =
  'px-4 py-2 rounded-lg font-medium transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2';
const NEUTRAL_BUTTON = `${BUTTON_BASE} text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 focus:ring-indigo-500`;
const DANGER_BUTTON = `${BUTTON_BASE} bg-red-600 hover:bg-red-700 text-white focus:ring-red-500`;

/**
 * The one place that tells an admin their save of the platform or UI
 * configuration was refused because the file changed after they opened the
 * page (`412 PRECONDITION_FAILED`, raised by `api/adminConfigRevision.js`).
 *
 * Nothing was saved and nothing on the page is touched: the admin's edits stay
 * in the form. They choose between:
 * - **Close** (also Escape and a click on the backdrop): closes the dialog and
 *   changes nothing else. The stale revision is kept, so the next save is
 *   refused again and this dialog returns. This is the only harmless choice,
 *   so it has the initial focus: an Enter or Escape typed out of habit loses
 *   nobody's work.
 * - **Reload and discard my changes**: shows the current configuration and
 *   drops the admin's own unsaved edits. Destructive for the admin only, and
 *   the label says so; styled neutral because it never touches anyone else's
 *   saved work.
 * - **Keep my changes and overwrite on next save**: re-reads the current
 *   revision into the refused form's own revision holder (the event carries
 *   it; no other form's revision changes), so that form's next save goes through and
 *   replaces the newer version, including the other person's change. That
 *   destroys someone else's saved work, so it is styled as the dangerous
 *   action and only ever happens on an explicit click. A further change by
 *   someone else after this re-read is again refused with this dialog.
 *
 * Built here rather than on `ConfirmDialog`, which has two buttons and routes
 * Escape and the backdrop to its deny action.
 *
 * Never retried or merged silently: nothing is saved until the admin saves.
 *
 * Rendered once by `AdminLayout`.
 *
 * @param {Object} props
 * @param {() => void} [props.onReload] - Reloads the page; defaults to a full reload
 */
export default function AdminConfigConflictNotice({ onReload }) {
  const { t } = useTranslation();
  const [resource, setResource] = useState(null);
  // The refused form's revision holder, from the conflict event.
  const revisionRef = useRef(null);
  const containerRef = useRef(null);
  const closeButtonRef = useRef(null);
  const isOpen = resource !== null;

  useFocusTrap(containerRef, {
    isActive: isOpen,
    initialFocusRef: closeButtonRef,
    returnFocusOnDeactivate: true
  });

  useEffect(() => {
    const onConflict = event => {
      revisionRef.current = event.detail?.revision ?? null;
      setResource(event.detail?.resource || 'platform');
    };
    window.addEventListener(CONFIG_CONFLICT_EVENT, onConflict);
    return () => window.removeEventListener(CONFIG_CONFLICT_EVENT, onConflict);
  }, []);

  /** Close only: the stale revision stays, so the next save is refused again. */
  const close = useCallback(() => setResource(null), []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  const keepAndOverwrite = useCallback(() => {
    const url = revisionReadUrlOf(resource);
    const revision = revisionRef.current;
    setResource(null);
    if (!url || !revision) return;
    // Only the revision matters: `makeAdminApiCall` stores the ETag of the read
    // in the refused form's holder, and in no other. If the read fails, the
    // next save is refused again and this dialog returns.
    makeAdminApiCall(url, { method: 'GET', revision }).catch(error => {
      console.warn('Could not re-read the configuration revision:', error);
    });
  }, [resource]);

  const reload = useCallback(() => {
    setResource(null);
    if (onReload) onReload();
    else window.location.reload();
  }, [onReload]);

  if (!isOpen) return null;

  const resourceName =
    resource === 'ui'
      ? t('admin.configConflict.resource.ui', 'UI customization')
      : t('admin.configConflict.resource.platform', 'platform configuration');

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div
        className="fixed inset-0 bg-black/50 transition-opacity"
        onClick={close}
        aria-hidden="true"
        data-testid="config-conflict-backdrop"
      />
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={containerRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="config-conflict-title"
          aria-describedby="config-conflict-message"
          className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full"
        >
          <div className="p-6 flex items-start gap-4">
            <div
              className="shrink-0 w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/40 flex items-center justify-center"
              aria-hidden="true"
            >
              <Icon
                name="exclamation-triangle"
                className="w-6 h-6 text-red-700 dark:text-red-400"
              />
            </div>
            <div className="flex-1 min-w-0">
              <h2
                id="config-conflict-title"
                className="text-lg font-semibold text-gray-900 dark:text-white"
              >
                {t('admin.configConflict.title', 'This changed since you opened it')}
              </h2>
              <div
                id="config-conflict-message"
                className="mt-2 text-sm text-gray-600 dark:text-gray-300"
              >
                {t(
                  'admin.configConflict.message',
                  'Someone saved the {{resource}} after you opened this page (another administrator, another tab or a script). Your changes were not saved and are still on the page. Reload to see the current version and make your changes again, or keep your changes: your next save then replaces the newer version, including what the other person changed. If you close this dialog, your next save is refused again.',
                  { resource: resourceName }
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 rounded-b-lg">
            <button ref={closeButtonRef} type="button" onClick={close} className={NEUTRAL_BUTTON}>
              {t('admin.configConflict.close', 'Close')}
            </button>
            <button type="button" onClick={reload} className={NEUTRAL_BUTTON}>
              {t('admin.configConflict.reload', 'Reload and discard my changes')}
            </button>
            <button type="button" onClick={keepAndOverwrite} className={DANGER_BUTTON}>
              {t('admin.configConflict.keep', 'Keep my changes and overwrite on next save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
