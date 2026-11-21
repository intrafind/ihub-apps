// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { SECONDARY_BUTTON_CLASS } from '../formStyles';

/**
 * Shown in the test panel instead of the chat when an app that is not
 * published cannot be loaded for its author. Creating an app grants no group,
 * and the test chat checks group permission like every chat; on an
 * installation where not every signed-in user gets every app, the author's own
 * new app is then "not found". The message names the cause and leads to the
 * place where a group gets access.
 *
 * @param {object} props
 * @param {() => void} [props.onOpenAccess] - Opens "Who can use this app".
 * @returns {JSX.Element}
 */
function TestNoAccessMessage({ onOpenAccess }) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Icon name="lock" className="h-8 w-8 mx-auto text-gray-500" aria-hidden="true" />
        <h3 className="mt-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.apps.edit.testNoAccess.title')}
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          {t('admin.apps.edit.testNoAccess.body')}
        </p>
        {onOpenAccess && (
          <button type="button" onClick={onOpenAccess} className={`${SECONDARY_BUTTON_CLASS} mt-4`}>
            {t('admin.apps.edit.groups.access')}
          </button>
        )}
      </div>
    </div>
  );
}

export default TestNoAccessMessage;
