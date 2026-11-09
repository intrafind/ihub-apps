// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * The red button that deletes (or removes) the ticked items of a project. While
 * the removal runs it is off and spins.
 *
 * @param {Object} props
 * @param {boolean} [props.busy=false]
 * @param {() => void} props.onClick
 * @param {string} [props.className] - Its rounding, to match the buttons beside it.
 * @param {React.ReactNode} props.children - The label.
 * @returns {JSX.Element}
 */
export function SelectionDeleteButton({
  busy = false,
  onClick,
  className = 'rounded-lg',
  children
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center gap-1 bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 ${className}`}
    >
      <Icon
        name={busy ? 'arrow-path' : 'trash'}
        size="sm"
        className={busy ? 'animate-spin' : undefined}
      />
      {children}
    </button>
  );
}

/**
 * The bar above a project's documents while some are ticked: how many, the
 * actions for them, and **Clear**. While an action runs (`busy`) Clear is off.
 *
 * @param {Object} props
 * @param {string} props.label - E.g. "3 documents selected".
 * @param {boolean} [props.busy=false]
 * @param {() => void} props.onClear
 * @param {React.ReactNode} props.children - The action buttons.
 * @returns {JSX.Element}
 */
function ItemSelectionBar({ label, busy = false, onClear, children }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="project-item-selection-bar"
      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 dark:border-indigo-800 dark:bg-indigo-900/30"
    >
      <span className="text-sm font-medium text-indigo-800 dark:text-indigo-200">{label}</span>
      <div className="flex gap-2">
        {children}
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {t('common.clearSelection', 'Clear')}
        </button>
      </div>
    </div>
  );
}

export default ItemSelectionBar;
