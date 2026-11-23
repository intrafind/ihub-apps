// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { fetchContentAccess, fetchItemAccess } from '../../../../api/adminApi';
import AccessTools from './AccessTools';
import { useItemAccess } from './useItemAccess';

/**
 * The restrict helper and the access check as a card of their own, for a page
 * that already lists the groups elsewhere (the app editor's group access).
 *
 * A full admin gets both helpers over the full-admin access view
 * (`GET /api/admin/access/{type}/{id}`). A content admin gets the check only,
 * over the view the group access card reads for them
 * (`GET /api/admin/content-access/{type}/{id}`): the groups they manage, which
 * are the groups the server lets them check.
 *
 * @param {object} props
 * @param {'apps'|'models'} props.type
 * @param {string} props.id
 * @param {string} props.itemName
 * @param {unknown} [props.refreshKey] - Loads the view again when it changes
 * @param {(view: object) => void} [props.onRestricted] - Called after "Restrict access" applied
 * @param {boolean} [props.fullAdmin=true] - False for a content admin
 * @param {string} [props.className]
 * @returns {JSX.Element|null}
 */
function ItemAccessTools({
  type,
  id,
  itemName,
  refreshKey,
  onRestricted,
  fullAdmin = true,
  className = ''
}) {
  const { t } = useTranslation();
  const { view, setView } = useItemAccess({
    type,
    id,
    refreshKey,
    load: fullAdmin ? fetchItemAccess : fetchContentAccess
  });
  if (!view) return null;

  return (
    <div
      className={`bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6 ${className}`.trim()}
      data-testid="item-access-tools"
    >
      <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100 mb-3">
        {fullAdmin ? t('admin.access.tools.title') : t('admin.access.tools.checkTitle')}
      </h3>
      <AccessTools
        type={type}
        id={id}
        itemName={itemName}
        view={view}
        fullAdmin={fullAdmin}
        onRestricted={next => {
          setView(next);
          onRestricted?.(next);
        }}
      />
    </div>
  );
}

export default ItemAccessTools;
