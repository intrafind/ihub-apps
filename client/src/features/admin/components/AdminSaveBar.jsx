// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from './formStyles';

const ACTION_CLASS =
  'rounded-sm text-sm font-medium text-admin-accent dark:text-admin-accent-fg-dark underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

/**
 * Sticky bar at the bottom of an admin settings page: says there are unsaved
 * changes and offers Save and Discard. It shows only while there is something to
 * save (or a save is running), so a page without edits has no bar to ignore.
 *
 * A page can add one sentence about the pending save ("2 fields need your
 * attention.") and one action that belongs to it ("Show"). Both are left out
 * while a save runs.
 *
 * @param {Object} props
 * @param {boolean} props.dirty - There are unsaved changes
 * @param {boolean} props.saving - A save is running
 * @param {() => void} props.onSave
 * @param {() => void} [props.onDiscard] - Without it no Discard button is shown.
 * @param {React.ReactNode} [props.message] - A sentence shown beside "You have unsaved
 *   changes" and announced with it.
 * @param {{label: string, onClick: () => void}} [props.action] - A link-like button after
 *   the message.
 */
export default function AdminSaveBar({ dirty, saving, onSave, onDiscard, message, action }) {
  const { t } = useTranslation();
  if (!dirty && !saving) return null;
  return (
    <div
      className="sticky bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm border-t border-gray-200 dark:border-gray-700 shadow-lg"
      role="region"
      aria-label={t('admin.ui.saveBar.label', 'Save changes')}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <p
            role="status"
            aria-live="polite"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-700 dark:text-gray-300"
          >
            <span
              className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span>
              {saving
                ? t('admin.ui.saveBar.saving', 'Saving…')
                : t('admin.ui.saveBar.unsaved', 'You have unsaved changes')}
            </span>
            {message && !saving && <span data-testid="save-bar-message">{message}</span>}
          </p>
          {action && !saving && (
            <button type="button" onClick={action.onClick} className={ACTION_CLASS}>
              {action.label}
            </button>
          )}
        </div>
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
