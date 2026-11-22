// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import AdminSaveBar from '../AdminSaveBar';

/**
 * The save bar of the app editor. Beside "You have unsaved changes" it says
 * what the author should know before pressing Save:
 *
 * - with fields that need attention, how many there are, and "Show" leads to
 *   the first one (where the page can lead there);
 * - else, where the page cannot count fields (the JSON editor) and the app
 *   cannot be saved as it is, the sentence it passes as `invalidMessage`;
 * - else, for a published app, that users get the change at once.
 *
 * @param {object} props
 * @param {boolean} props.dirty - There are unsaved changes.
 * @param {boolean} props.saving - A save is running.
 * @param {() => void} props.onSave
 * @param {() => void} props.onDiscard
 * @param {number} [props.errorCount=0] - Fields that need attention.
 * @param {string|null} [props.invalidMessage] - Why a save would not go through, where
 *   no field can be counted.
 * @param {boolean} [props.published=false] - The saved app is published.
 * @param {(() => void)|null} [props.onShowFirstError] - Leads to the first field; without
 *   it no "Show" is offered.
 * @returns {JSX.Element|null}
 */
function EditorSaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  errorCount = 0,
  invalidMessage = null,
  published = false,
  onShowFirstError = null
}) {
  const { t } = useTranslation();
  let message;
  if (errorCount > 0) message = t('admin.apps.edit.fieldsNeedAttention', { count: errorCount });
  else if (invalidMessage) message = invalidMessage;
  else if (published) message = t('admin.apps.edit.liveHint');

  return (
    <AdminSaveBar
      dirty={dirty}
      saving={saving}
      onSave={onSave}
      onDiscard={onDiscard}
      message={message}
      action={
        errorCount > 0 && onShowFirstError
          ? { label: t('admin.apps.edit.showFirstError'), onClick: onShowFirstError }
          : undefined
      }
    />
  );
}

export default EditorSaveBar;
