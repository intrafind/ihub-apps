// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from './formStyles';

/**
 * Sticky bar at the bottom of an admin settings page: says there are unsaved
 * changes and offers Save and Discard. It shows only while there is something to
 * save (or a save is running), so a page without edits has no bar to ignore.
 *
 * @param {Object} props
 * @param {boolean} props.dirty - There are unsaved changes
 * @param {boolean} props.saving - A save is running
 * @param {() => void} props.onSave
 * @param {() => void} [props.onDiscard] - Without it no Discard button is shown.
 */
export default function AdminSaveBar({ dirty, saving, onSave, onDiscard }) {
  const { t } = useTranslation();
  if (!dirty && !saving) return null;
  return (
    <div
      className="sticky bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm border-t border-gray-200 dark:border-gray-700 shadow-lg"
      role="region"
      aria-label={t('admin.ui.saveBar.label', 'Save changes')}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
        >
          <span
            className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse motion-reduce:animate-none"
            aria-hidden="true"
          />
          {saving
            ? t('admin.ui.saveBar.saving', 'Saving…')
            : t('admin.ui.saveBar.unsaved', 'You have unsaved changes')}
        </p>
        <div className="flex items-center gap-2">
          {onDiscard && (
            <button
              type="button"
              onClick={onDiscard}
              disabled={saving}
              className={SECONDARY_BUTTON_CLASS}
            >
              {t('admin.ui.saveBar.discard', 'Discard')}
            </button>
          )}
          <button type="button" onClick={onSave} disabled={saving} className={PRIMARY_BUTTON_CLASS}>
            {saving ? t('admin.ui.saveBar.saving', 'Saving…') : t('admin.ui.save', 'Save Changes')}
          </button>
        </div>
      </div>
    </div>
  );
}
