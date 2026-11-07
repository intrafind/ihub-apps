// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * A "⋯" button that opens a menu of secondary actions.
 *
 * Keyboard: Enter/Space/ArrowDown opens, ArrowUp/ArrowDown move, Escape closes
 * and returns focus to the button, Tab closes. Clicking outside closes.
 *
 * @param {Object} props
 * @param {Array<{ id: string, label: string, onSelect: () => void, destructive?: boolean, disabled?: boolean }>} props.items
 * @param {string} [props.label] Accessible name of the button
 */
function MoreActionsMenu({ items, label }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) rootRef.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  const close = returnFocus => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onMenuKeyDown = event => {
    const entries = [...rootRef.current.querySelectorAll('[role="menuitem"]:not([disabled])')];
    const index = entries.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      entries[(index + 1) % entries.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      entries[(index - 1 + entries.length) % entries.length]?.focus();
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label || t('common.moreActions', 'More actions')}
        onClick={() => setOpen(prev => !prev)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2.5 py-2 text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
      >
        <Icon name="ellipsis-vertical" className="h-4 w-4" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-20 mt-2 w-48 origin-top-right rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-1 shadow-lg"
        >
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className={`block w-full px-4 py-2 text-left text-sm disabled:opacity-50 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-hidden ${
                item.destructive
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-gray-700 dark:text-gray-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default MoreActionsMenu;
