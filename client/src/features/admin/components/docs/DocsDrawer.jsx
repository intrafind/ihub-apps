// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useFocusTrap } from '../../../../shared/hooks/useFocusTrap';

/**
 * The left column of a docs-style page on small screens: a modal drawer from the left with a
 * title bar and its own scroll. Used by Documentation (the contents) and What's New (the
 * releases), so both pages open their navigation the same way.
 *
 * @param {{ open: boolean, onClose: () => void, label: string, title: string,
 *   children: import('react').ReactNode }} props
 */
export default function DocsDrawer({ open, onClose, label, title, children }) {
  const { t } = useTranslation();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  useFocusTrap(panelRef, { isActive: open, initialFocusRef: closeRef });
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 h-full w-full cursor-default bg-gray-900/40"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="absolute inset-y-0 left-0 flex w-80 max-w-[85vw] flex-col bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-gray-800">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}
