// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import Icon from '../../../shared/components/Icon';

const ROW =
  'flex w-full items-center justify-between gap-2 rounded-lg p-2 text-left focus:outline-hidden focus:ring-2 focus:ring-inset focus:ring-indigo-500';

/**
 * A row of the chat's "+" menu with a choice behind it: the title and the
 * current value on the row, the options in a list that opens under it. It
 * opens in place, not as a flyout: a side flyout is clipped by the scrolling
 * menu, needs hover, and does not work on touch.
 *
 * Keys: Enter, Space or ArrowRight opens it, ArrowDown walks into the options,
 * ArrowLeft or Escape closes it and keeps the focus on the row (Escape closes
 * only the list while it is open; see `useKeyboardNavigation`). A pick closes
 * the list and calls `onPicked` (the menu closes then).
 *
 * @param {Object} props
 * @param {string} props.title - What the row is about ("Project knowledge").
 * @param {string} props.valueLabel - The current choice, as text.
 * @param {string} [props.icon] - `Icon` name shown before the title.
 * @param {Array<{id: string, label: string, description?: string, group?: string}>} props.options -
 *   A `group` heading is shown above the first option of each group.
 * @param {string} props.selectedId - The `id` of the current option.
 * @param {(id: string) => void} props.onSelect
 * @param {() => void} [props.onPicked] - Called after a pick.
 * @param {boolean} [props.disabled] - The list cannot be opened.
 * @param {boolean} [props.locked] - Fixed by the app: shown with a lock, no list.
 * @param {string} [props.lockedReason] - Why it is fixed, read by screen readers.
 * @param {string} [props.footnote] - A muted line under the options.
 * @param {string} [props.id] - Stable hook for tests and `aria-controls`.
 * @returns {JSX.Element}
 */
export default function SubmenuRow({
  title,
  valueLabel,
  icon,
  options,
  selectedId,
  onSelect,
  onPicked,
  disabled = false,
  locked = false,
  lockedReason,
  footnote,
  id = 'submenu'
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef(null);
  const canOpen = !locked && !disabled && options.length > 0;
  const expanded = canOpen && open;
  const listId = `${id}-options`;
  const reasonId = `${id}-reason`;

  const toggle = () => {
    if (canOpen) setOpen(!expanded);
  };
  const close = () => {
    setOpen(false);
    rowRef.current?.focus();
  };
  const choose = optionId => {
    onSelect(optionId);
    setOpen(false);
    onPicked?.();
  };

  let lastGroup;
  return (
    // `data-submenu-open` tells the menu's key handler that Escape belongs to
    // this list first.
    <div
      role="none"
      data-submenu-open={expanded ? 'true' : undefined}
      onKeyDown={event => {
        if (expanded && (event.key === 'Escape' || event.key === 'ArrowLeft')) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <div
        ref={rowRef}
        role="menuitem"
        tabIndex={-1}
        data-submenu={id}
        aria-haspopup={canOpen ? 'menu' : undefined}
        aria-expanded={canOpen ? expanded : undefined}
        aria-controls={expanded ? listId : undefined}
        aria-disabled={canOpen ? undefined : 'true'}
        aria-describedby={locked && lockedReason ? reasonId : undefined}
        aria-label={`${title}: ${valueLabel}`}
        className={`${ROW} ${
          canOpen
            ? 'cursor-pointer hover:bg-gray-50 focus:bg-gray-50 dark:hover:bg-gray-700 dark:focus:bg-gray-700'
            : ''
        }`}
        onClick={toggle}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          } else if (event.key === 'ArrowRight' && canOpen && !expanded) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon && (
            <Icon
              name={icon}
              size="sm"
              aria-hidden="true"
              className="shrink-0 text-gray-500 dark:text-gray-400"
            />
          )}
          <span className="min-w-0">
            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              {title}
            </span>
            <span className="block truncate text-xs text-gray-600 dark:text-gray-300">
              {valueLabel}
            </span>
          </span>
        </span>
        <Icon
          name={locked ? 'lock-closed' : expanded ? 'chevronDown' : 'chevronRight'}
          size="sm"
          aria-hidden="true"
          className="shrink-0 text-gray-500 dark:text-gray-400"
        />
      </div>
      {locked && lockedReason && (
        <p id={reasonId} className="px-2 pb-1 text-xs text-gray-600 dark:text-gray-300">
          {lockedReason}
        </p>
      )}
      {expanded && (
        <div
          id={listId}
          role="group"
          aria-label={title}
          className="ml-4 mt-1 space-y-0.5 border-l border-gray-200 pl-2 dark:border-gray-700"
        >
          {options.map(option => {
            const heading = option.group && option.group !== lastGroup ? option.group : null;
            lastGroup = option.group;
            const selected = option.id === selectedId;
            return (
              <div key={option.id || '__inherit'} role="none">
                {heading && (
                  <div
                    aria-hidden="true"
                    className="px-2 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                  >
                    {heading}
                  </div>
                )}
                <div
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={selected}
                  data-option={option.id || 'inherit'}
                  className={`flex cursor-pointer items-start justify-between gap-2 rounded-md px-2 py-2 focus:outline-hidden focus:ring-2 focus:ring-inset focus:ring-indigo-500 ${
                    selected
                      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                      : 'text-gray-800 hover:bg-gray-50 focus:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700 dark:focus:bg-gray-700'
                  }`}
                  onClick={() => choose(option.id)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      choose(option.id);
                    }
                  }}
                >
                  <span className="min-w-0">
                    <span className="block text-sm">{option.label}</span>
                    {option.description && (
                      <span
                        className={`block text-xs ${
                          selected
                            ? 'text-indigo-700 dark:text-indigo-300'
                            : 'text-gray-600 dark:text-gray-300'
                        }`}
                      >
                        {option.description}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <Icon name="check" size="sm" aria-hidden="true" className="mt-0.5 shrink-0" />
                  )}
                </div>
              </div>
            );
          })}
          {footnote && (
            <p className="px-2 pt-1 text-xs text-gray-600 dark:text-gray-300">{footnote}</p>
          )}
        </div>
      )}
    </div>
  );
}
