// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { makeAdminApiCall } from '../../../api/adminApi';
import { CONFIG_CONFLICT_EVENT, revisionReadUrlOf } from '../../../api/adminConfigRevision';

/**
 * The one place that tells an admin their save of the platform or UI
 * configuration was refused because the file changed after they opened the
 * page (`412 PRECONDITION_FAILED`, raised by `api/adminConfigRevision.js`).
 *
 * Nothing was saved and nothing on the page is touched: the admin's edits stay
 * in the form. They choose between:
 * - reloading, which shows the current configuration and discards their
 *   unsaved edits;
 * - keeping their edits, which re-reads the current revision (the read stores
 *   its `ETag`), so their next save goes through and replaces the newer
 *   version. The button says so: choosing it is the explicit decision to
 *   overwrite. A further change by someone else after this re-read is again
 *   refused with this dialog.
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

  useEffect(() => {
    const onConflict = event => setResource(event.detail?.resource || 'platform');
    window.addEventListener(CONFIG_CONFLICT_EVENT, onConflict);
    return () => window.removeEventListener(CONFIG_CONFLICT_EVENT, onConflict);
  }, []);

  const keepEditing = useCallback(() => {
    const url = revisionReadUrlOf(resource);
    setResource(null);
    if (!url) return;
    // Only the revision matters: `makeAdminApiCall` remembers the ETag of the
    // read. If it fails, the next save is refused again and this dialog returns.
    makeAdminApiCall(url, { method: 'GET' }).catch(error => {
      console.warn('Could not re-read the configuration revision:', error);
    });
  }, [resource]);
  const reload = useCallback(() => {
    setResource(null);
    if (onReload) onReload();
    else window.location.reload();
  }, [onReload]);

  const resourceName =
    resource === 'ui'
      ? t('admin.configConflict.resource.ui', 'UI customization')
      : t('admin.configConflict.resource.platform', 'platform configuration');

  return (
    <ConfirmDialog
      isOpen={resource !== null}
      title={t('admin.configConflict.title', 'This changed since you opened it')}
      message={t(
        'admin.configConflict.message',
        'Someone saved the {{resource}} after you opened this page (another administrator, another tab or a script). Your changes were not saved and are still on the page. Reload to see the current version and make your changes again, or keep your changes: your next save then replaces the newer version, including what the other person changed.',
        { resource: resourceName }
      )}
      confirmLabel={t('admin.configConflict.reload', 'Reload and discard my changes')}
      denyLabel={t('admin.configConflict.keep', 'Keep my changes and overwrite on next save')}
      danger
      onConfirm={reload}
      onDeny={keepEditing}
    />
  );
}
