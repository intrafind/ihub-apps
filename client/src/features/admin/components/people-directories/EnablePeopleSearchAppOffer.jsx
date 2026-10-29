// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { getAdminApiErrorMessage, toggleApps } from '../../../../api/adminApi';
import { PEOPLE_SEARCH_APP_ID } from '../../utils/peopleDirectories';
import { CALLOUT_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from './formStyles';

/**
 * Non-blocking offer shown after a directory was switched on while the shipped
 * "People search" app (`people-directory`) is still disabled: one click enables
 * the app, another dismisses the offer. Nothing happens without a click.
 *
 * @param {Object} props
 * @param {() => void} props.onDone - Called after the app was enabled or the offer dismissed
 * @param {() => void} [props.onEnabled] - Called after the app was enabled
 */
function EnablePeopleSearchAppOffer({ onDone, onEnabled }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await toggleApps([PEOPLE_SEARCH_APP_ID], true);
      onEnabled?.();
      onDone();
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${CALLOUT_CLASS.info} mb-6`} role="status">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          <Icon name="information-circle" size="md" className="mt-0.5 shrink-0" />
          <p>
            {t(
              'admin.peopleDirectories.appOffer.text',
              'Also enable the “People search” app? Users can then ask for people in a chat, and it searches every directory they may use.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={enable} disabled={busy} className={PRIMARY_BUTTON_CLASS}>
            {busy
              ? t('admin.peopleDirectories.appOffer.enabling', 'Enabling…')
              : t('admin.peopleDirectories.appOffer.enable', 'Enable app')}
          </button>
          <button type="button" onClick={onDone} className={SECONDARY_BUTTON_CLASS}>
            {t('admin.peopleDirectories.appOffer.dismiss', 'Not now')}
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-800 dark:text-red-200">
          {t('admin.peopleDirectories.appOffer.error', 'The app could not be enabled: {{error}}', {
            error
          })}
        </p>
      )}
    </div>
  );
}

export default EnablePeopleSearchAppOffer;
