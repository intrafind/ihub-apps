// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { CONFIG_CONFLICT_EVENT } from '../../../api/adminConfigRevision';

/**
 * The one place that tells an admin their save of the platform or UI
 * configuration was refused because the file changed after they opened the
 * page (`412 PRECONDITION_FAILED`, raised by `api/adminConfigRevision.js`).
 *
 * Nothing was saved and nothing on the page is touched: the admin's edits stay
 * in the form. They choose between keeping the page as it is (to copy their
 * changes somewhere, or look at what changed in History) and reloading it,
 * which shows the current configuration and discards their unsaved edits.
 * Never retried or merged silently.
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

  const keepEditing = useCallback(() => setResource(null), []);
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
        'Someone saved the {{resource}} after you opened this page (another administrator, another tab or a script). Your changes were not saved and are still on the page. Reload to see the current version, then make your changes again.',
        { resource: resourceName }
      )}
      confirmLabel={t('admin.configConflict.reload', 'Reload and discard my changes')}
      denyLabel={t('admin.configConflict.keep', 'Keep my changes on the page')}
      danger
      onConfirm={reload}
      onDeny={keepEditing}
    />
  );
}
