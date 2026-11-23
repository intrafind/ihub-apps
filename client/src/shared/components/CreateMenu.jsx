// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import useCreateEntries from '../hooks/useCreateEntries';

const BUTTON_CLASS = {
  rail: open =>
    `w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
      open
        ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
    }`,
  expanded: open =>
    `w-11 h-full flex items-center justify-center rounded-xl border transition-colors ${
      open
        ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800'
    }`
};

// The rail is narrow: its menu opens to the right of the button. The expanded
// sidebar has room below, aligned to the button's right edge so it stays inside.
const MENU_POSITION = {
  rail: 'left-full top-0 ml-2',
  expanded: 'right-0 top-full mt-1'
};

/**
 * The sidebar's "Create" (+) control: a menu button listing what the viewer may
 * create (an app, a project, a skill, a prompt, a scheduled task; see
 * `useCreateEntries`). Nothing to create → nothing rendered.
 *
 * Keyboard: Enter/Space or ArrowDown open it on the first entry, ArrowUp on the
 * last; arrows, Home and End move within it; Escape closes it and returns the
 * focus to the button; Tab or a click outside closes it.
 *
 * @param {Object} props
 * @param {'rail'|'expanded'} [props.variant] - The collapsed icon rail or the expanded sidebar.
 * @param {() => void} [props.onNavigate] - Called after an entry navigated (closes the mobile drawer).
 */
export default function CreateMenu({ variant = 'expanded', onNavigate }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const entries = useCreateEntries();
  const [open, setOpen] = useState(false);
  // Which entry takes the focus when the menu opens: the first or the last.
  const [initialFocus, setInitialFocus] = useState('first');
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);
  const itemsRef = useRef([]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const items = itemsRef.current.filter(Boolean);
    (initialFocus === 'last' ? items[items.length - 1] : items[0])?.focus();
  }, [open, initialFocus]);

  if (entries.length === 0) return null;

  const label = t('sidebar.create.label', 'Create');
  const menuId = `sidebar-create-menu-${variant}`;

  const openMenu = focus => {
    setInitialFocus(focus);
    setOpen(true);
  };

  const close = ({ refocus = false } = {}) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onButtonKeyDown = event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu('last');
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close({ refocus: true });
    }
  };

  const onMenuKeyDown = event => {
    const items = itemsRef.current.filter(Boolean);
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ refocus: true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      close();
    }
  };

  const select = entry => {
    close();
    navigate(entry.to, entry.state ? { state: entry.state } : undefined);
    onNavigate?.();
  };

  return (
    <div ref={wrapperRef} className={`relative ${variant === 'expanded' ? 'flex' : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={`sidebar-create-${variant}`}
        onClick={() => (open ? close() : openMenu('first'))}
        onKeyDown={onButtonKeyDown}
        className={BUTTON_CLASS[variant](open)}
      >
        {/* A bare plus, not the circled plus of "New chat" right next to it. */}
        <Icon name="PlusIcon" size={variant === 'rail' ? 'md' : 'sm'} />
      </button>
      {open && (
        <ul
          id={menuId}
          role="menu"
          aria-label={t('sidebar.create.menu', 'Create new')}
          onKeyDown={onMenuKeyDown}
          className={`absolute z-30 ${MENU_POSITION[variant]} min-w-[11rem] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1`}
        >
          {entries.map((entry, index) => (
            <li key={entry.id} role="none">
              <button
                ref={element => {
                  itemsRef.current[index] = element;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-testid={`sidebar-create-${entry.id}`}
                onClick={() => select(entry)}
                className="w-full text-left px-3 py-2 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-hidden inline-flex items-center gap-2"
              >
                <Icon name={entry.icon} size="sm" className="text-gray-500 dark:text-gray-400" />
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
