// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import Icon from '../../../shared/components/Icon';
import { MENU_ITEM } from '../../../shared/utils/buttonTokens';

/**
 * A popup menu hung off a header button. Arrow keys, Home and End move between
 * items; Tab and a click outside close it; Esc closes it and returns focus to
 * its button. Esc is consumed here, so the pane underneath does not also close
 * (the innermost layer closes first).
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {boolean} props.open
 * @param {(open: boolean) => void} props.onToggle
 * @param {string} props.label - The menu's accessible name.
 * @param {(props: Object) => import('react').ReactNode} props.trigger - Renders the button.
 * @param {'left'|'right'} [props.align]
 * @param {string} [props.className]
 * @param {import('react').ReactNode} props.children - `PaneMenuItem`s.
 */
export default function PaneMenu({
  id,
  open,
  onToggle,
  label,
  trigger,
  align = 'left',
  className = '',
  children
}) {
  const menuRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() =>
      menuRef.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus()
    );
    const onPointerDown = event => {
      if (!wrapRef.current?.contains(event.target)) onToggle(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, onToggle]);

  const onKeyDown = event => {
    const items = Array.from(
      menuRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || []
    );
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onToggle(false);
      wrapRef.current?.querySelector('[aria-haspopup="menu"]')?.focus();
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
      onToggle(false);
    }
  };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      {trigger({
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        onClick: () => onToggle(!open)
      })}
      {open && (
        <div
          ref={menuRef}
          id={id}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          onKeyDown={onKeyDown}
          className={`absolute top-full z-30 mt-1 max-h-[70vh] min-w-[14rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-1 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * One item of a `PaneMenu`.
 *
 * @param {Object} props
 * @param {string} [props.icon]
 * @param {string} props.label
 * @param {() => void} props.onClick
 * @param {boolean} [props.current] - Marks the item that is shown (title switcher).
 * @param {boolean} [props.danger]
 * @param {string} [props.hint] - A second, smaller line.
 */
export function PaneMenuItem({
  icon,
  label,
  onClick,
  current = false,
  danger = false,
  hint,
  ...rest
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={current ? 'true' : undefined}
      className={`${MENU_ITEM} ${current ? 'bg-indigo-50 dark:bg-indigo-900/30 font-medium' : ''} ${danger ? 'text-red-700 dark:text-red-300' : ''}`}
      onClick={onClick}
      {...rest}
    >
      {icon && <Icon name={icon} size="sm" className="flex-none" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && (
          <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{hint}</span>
        )}
      </span>
    </button>
  );
}

/** A group heading inside a menu. */
export function PaneMenuGroup({ label }) {
  return (
    <div
      role="presentation"
      className="px-3 pt-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
    >
      {label}
    </div>
  );
}
