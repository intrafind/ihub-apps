// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { CALLOUT_CLASS } from '../../../admin/components/formStyles';

/** A stored date as the reader's locale writes it; the stored text when it is no date. */
function dateText(value, language) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return value ? String(value) : '';
  return date.toLocaleDateString(language || undefined);
}

/**
 * Why a personal app cannot be changed by the person looking at it, above the
 * form of the editor: switched off by an administrator, now a company app
 * (or published and waiting for an administrator to switch it on),
 * the owner's account inactive, or a capability this editor may not use. It
 * also says when the owner's shares do not count at the moment.
 *
 * Nothing is rendered when there is nothing to say (a member with "Can use"
 * reads the form without a banner).
 *
 * @param {object} props
 * @param {object} props.app - The app as the server answered it.
 * @param {{reason: string, capability?: object}|null} props.readOnly - The result of
 *   `readOnlyReason(app)`.
 * @param {(capability: object) => string} props.capabilityName - The name of a capability
 *   as it stands inside a sentence ("the chosen AI model", "Jira").
 * @returns {JSX.Element|null}
 */
function UserAppStatusBanner({ app, readOnly, capabilityName }) {
  const { t, i18n } = useTranslation();
  let text = null;
  if (readOnly?.reason === 'disabled') {
    text = app.disabled?.reason
      ? t('userApps.edit.readOnly.disabled', { reason: app.disabled.reason })
      : t('userApps.edit.state.disabled');
  } else if (readOnly?.reason === 'promoted') {
    // Published, and an administrator has not switched the company app on yet:
    // the owner looks here, nobody is notified.
    text = t(
      app.publishedAs?.enabled === false
        ? 'userApps.publish.waiting'
        : 'userApps.edit.readOnly.promoted',
      { date: dateText(app.publishedAs?.at, i18n.language) }
    );
  } else if (readOnly?.reason === 'ownerInactive') {
    text = t('userApps.edit.readOnly.ownerInactive');
  } else if (readOnly?.reason === 'capability') {
    text = t('userApps.edit.readOnly.capability', {
      capability: capabilityName(readOnly.capability)
    });
  } else if (app.permissions?.suspended) {
    text = t('userApps.notice.suspended', { owner: app.owner?.name || '' });
  }
  if (!text) return null;
  return (
    <p
      role="status"
      data-testid="user-app-status"
      data-reason={readOnly?.reason || 'suspended'}
      className={`mt-6 flex items-start gap-2 ${CALLOUT_CLASS.warning}`}
    >
      <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

export default UserAppStatusBanner;
