// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';

/**
 * The "Leave without saving?" dialog shown when `useUnsavedChanges` holds a
 * navigation away from a page with unsaved edits. Every admin editor renders
 * this one component so the wording is the same everywhere:
 * "Stay" (initial focus, Escape, backdrop) keeps the user on the page with their
 * edits; "Discard changes" (danger) runs the held navigation.
 *
 * @param {Object} props
 * @param {{state: 'blocked'|'unblocked', proceed: () => void, reset: () => void}} props.blocker
 *   The `blocker` returned by `useUnsavedChanges` (or `useAdminResourceEditor`).
 * @returns {JSX.Element}
 *
 * @example
 * const { blocker } = useUnsavedChanges(saved, draft);
 * return <><Form /><UnsavedChangesDialog blocker={blocker} /></>;
 */
export default function UnsavedChangesDialog({ blocker }) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      isOpen={blocker?.state === 'blocked'}
      title={t('admin.unsavedChanges.title', 'Leave without saving?')}
      message={t('admin.unsavedChanges.message', 'Your changes will be lost.')}
      confirmLabel={t('admin.unsavedChanges.discard', 'Discard changes')}
      denyLabel={t('admin.unsavedChanges.stay', 'Stay')}
      danger
      onConfirm={() => blocker?.proceed?.()}
      onDeny={() => blocker?.reset?.()}
    />
  );
}
