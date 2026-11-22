// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { makeAdminApiCall } from '../../../api/adminApi';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { CALLOUT_CLASS } from './formStyles';

/**
 * The line above the list of the "Apps" tab: "2 apps published by users are
 * not switched on yet.", with the names as links to the admin editor, where
 * an admin tests the app and publishes it.
 *
 * Nobody is notified when a user publishes an app; this line is how a content
 * admin learns about it. It reads `GET /api/admin/user-apps/_waiting`, which
 * says nothing about the personal app the company app came from. Nothing is
 * rendered when no app waits or the list cannot be read. While the personal
 * apps feature is off the list is not requested, so the page is unchanged.
 *
 * @returns {JSX.Element|null}
 */
function WaitingAppsNotice() {
  const { t, i18n } = useTranslation();
  const featureOn = useFeatureFlags().isEnabled('userApps', false);
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!featureOn) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => makeAdminApiCall('/admin/user-apps/_waiting'))
      .then(response => {
        const list = response?.data?.items;
        if (active && Array.isArray(list)) setItems(list.filter(item => item?.appId));
      })
      // The line is a hint. Without it the page is the page of today.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [featureOn]);

  if (!featureOn || items.length === 0) return null;
  return (
    <div role="status" data-testid="waiting-apps-notice" className={`mb-4 ${CALLOUT_CLASS.info}`}>
      <p>{t('admin.userApps.waiting.notice', { count: items.length })}</p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {items.map(item => (
          <li key={item.appId}>
            <Link
              to={`/admin/apps/${encodeURIComponent(item.appId)}`}
              className="rounded-sm font-medium underline hover:no-underline focus:outline-hidden focus:ring-2 focus:ring-admin-accent"
            >
              {getLocalizedContent(item.name, i18n.language) || item.appId}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default WaitingAppsNotice;
