// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CALLOUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../../../admin/components/formStyles';

/** How many members the banner names before "Show all". */
const SHOWN_MEMBERS = 2;

const LINK_CLASS =
  'rounded-sm text-sm font-medium underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent';

/**
 * What the receiver of an offer reads above the instructions of the app: who
 * wants to hand it over, what owning it means, who it is shared with, and the
 * three answers. The app stays with its owner until "Take over".
 *
 * The component makes no request; the page does, with the revision it loaded.
 *
 * @param {object} props
 * @param {object} props.app - The app as the server answered it (`owner`, `members`,
 *   `pendingOwner`).
 * @param {() => void} props.onTry - "Try it": chat with the app.
 * @param {() => void} props.onDecline
 * @param {() => void} props.onAccept
 * @param {boolean} [props.busy=false] - An answer is on its way.
 * @param {string|null} [props.error] - Why the last answer did not go through.
 * @param {string|null} [props.notice] - A sentence about the app itself (it was changed
 *   after the receiver opened it).
 * @returns {JSX.Element}
 */
function UserAppOfferBanner({
  app,
  onTry,
  onDecline,
  onAccept,
  busy = false,
  error = null,
  notice = null
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const members = Array.isArray(app.members) ? app.members : [];
  const from = app.pendingOwner?.offeredBy?.name || app.owner?.name || '';

  const describe = member => {
    const name =
      member.type === 'everyone' ? t('userApps.share.everyone') : member.name || member.id;
    const role = t(
      member.role === 'editor' ? 'userApps.share.role.editor' : 'userApps.share.role.user'
    );
    return `${name} (${role.charAt(0).toLowerCase()}${role.slice(1)})`;
  };
  const shown = showAll ? members : members.slice(0, SHOWN_MEMBERS);
  const hidden = members.length - shown.length;
  const list = [
    ...shown.map(describe),
    ...(hidden > 0 ? [t('userApps.transfer.receivedMore', { count: hidden })] : [])
  ].join(', ');

  return (
    <section
      aria-label={t('userApps.transfer.received', { from })}
      data-testid="user-app-offer"
      className={`mt-6 space-y-2 ${CALLOUT_CLASS.info}`}
    >
      <p className="font-medium">{t('userApps.transfer.received', { from })}</p>
      <p>{t('userApps.transfer.receivedDuty')}</p>
      {members.length > 0 && (
        <p data-testid="user-app-offer-members">
          {t('userApps.transfer.receivedMembers', { list })}{' '}
          {hidden > 0 && (
            <button type="button" className={LINK_CLASS} onClick={() => setShowAll(true)}>
              {t('userApps.transfer.showAll')}
            </button>
          )}
        </p>
      )}
      {members.some(member => member.role === 'editor') && (
        <p>{t('userApps.transfer.receivedEditors')}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" onClick={onTry} className={SECONDARY_BUTTON_CLASS}>
          {t('userApps.transfer.try')}
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={busy}
          className={SECONDARY_BUTTON_CLASS}
        >
          {t('userApps.transfer.decline')}
        </button>
        <button type="button" onClick={onAccept} disabled={busy} className={PRIMARY_BUTTON_CLASS}>
          {t('userApps.transfer.accept')}
        </button>
      </div>
    </section>
  );
}

export default UserAppOfferBanner;
