// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { HELP_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import AccessCheckPanel from './AccessCheckPanel';
import RestrictAccessDialog from './RestrictAccessDialog';
import { ITEM_KEYS, coveredByWildcard } from './accessExplanation';

/**
 * The two access helpers of an app or a model page: "Restrict access…" (W3),
 * offered while a wildcard grants the item, and the access check.
 *
 * The page owns the access view (see `useItemAccess`) so that the card around
 * this block and the block agree on what they show.
 *
 * @param {object} props
 * @param {'apps'|'models'} props.type
 * @param {string} props.id
 * @param {string} props.itemName - As the admin reads it, for the dialog title
 * @param {object|null} props.view - The item's access view
 * @param {(view: object) => void} props.onRestricted - Called with the view after the change
 * @returns {JSX.Element|null}
 */
function AccessTools({ type, id, itemName, view, onRestricted }) {
  const { t } = useTranslation();
  const [restrictOpen, setRestrictOpen] = useState(false);
  if (!view) return null;

  const items = t(ITEM_KEYS[type] || ITEM_KEYS.apps);
  const canRestrict = view.restrictable === true && coveredByWildcard(view);

  return (
    <div className="space-y-4" data-testid="access-tools">
      {canRestrict && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <button
            type="button"
            onClick={() => setRestrictOpen(true)}
            className={SECONDARY_BUTTON_CLASS}
          >
            <Icon name="lock" className="h-4 w-4" />
            {t('admin.access.restrict.open')}
          </button>
          <p className={`${HELP_CLASS} sm:mt-0`}>
            {t('admin.access.restrict.openHelp', { items })}
          </p>
        </div>
      )}

      <AccessCheckPanel type={type} id={id} groups={view.groups} />

      <RestrictAccessDialog
        isOpen={restrictOpen}
        type={type}
        id={id}
        itemName={itemName}
        groups={view.groups}
        onClose={() => setRestrictOpen(false)}
        onApplied={onRestricted}
      />
    </div>
  );
}

export default AccessTools;
