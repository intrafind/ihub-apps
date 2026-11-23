// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { CALLOUT_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';

/**
 * Says that no AI model is set up, and what to do about it. It stands where a
 * control would otherwise be dead: in place of the description box on the
 * "New app" page, and in the test panel of the app editor.
 *
 * Someone who may set up models gets the link to that page. Everyone else is
 * told to ask an administrator, because the page would refuse them.
 *
 * @param {object} props
 * @param {string|null} [props.setupHref] - Where a model is set up, for
 *   someone who may open that page; without it the notice says whom to ask.
 * @param {string} [props.className]
 * @returns {JSX.Element}
 */
function NoModelNotice({ setupHref = null, className = '' }) {
  const { t } = useTranslation();
  return (
    <div role="status" className={`${CALLOUT_CLASS.warning} ${className}`}>
      <p className="flex items-start gap-2 font-semibold">
        <Icon
          name="exclamation-triangle"
          size="sm"
          className="mt-0.5 shrink-0"
          aria-hidden="true"
        />
        <span>{t('admin.apps.create.noModel.title')}</span>
      </p>
      <p className="mt-1">{t('admin.apps.create.noModel.body')}</p>
      {setupHref ? (
        <p className="mt-3">
          <Link to={setupHref} className={SECONDARY_BUTTON_CLASS}>
            {t('admin.apps.create.noModel.actionAdmin')}
          </Link>
        </p>
      ) : (
        <p className="mt-1">{t('admin.apps.create.noModel.actionOther')}</p>
      )}
    </div>
  );
}

export default NoModelNotice;
