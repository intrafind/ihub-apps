import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../../../shared/components/Icon';

/**
 * Vertical-dots popover for row overflow actions.
 *
 * Keyboard support: Enter/Space toggles, Esc closes and returns focus to the
 * trigger, ArrowDown/Up cycle through menu items, Tab exits the menu.
 */
function DataTableKebabMenu({ items, label = 'More actions', row }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);

  const close = useCallback(({ returnFocus = true } = {}) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Click-outside close (mousedown matches ArtifactDownloadMenu convention).
  useEffect(() => {
    if (!open) return undefined;
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) close({ returnFocus: false });
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // Move focus to first menu item when opening.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const handleTriggerKeyDown = e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const handleMenuKeyDown = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      // Let Tab exit the menu naturally, but close so focus doesn't get stuck.
      close({ returnFocus: false });
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const focusable = itemRefs.current.filter(Boolean);
    if (focusable.length === 0) return;
    const currentIdx = focusable.indexOf(document.activeElement);
    let nextIdx = currentIdx;
    if (e.key === 'ArrowDown') nextIdx = (currentIdx + 1) % focusable.length;
    else if (e.key === 'ArrowUp') nextIdx = (currentIdx - 1 + focusable.length) % focusable.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = focusable.length - 1;
    focusable[nextIdx]?.focus();
  };

  if (!items || items.length === 0) return null;

  return (
    <div className="relative inline-block" ref={ref} onClick={e => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(v => !v)}
        onKeyDown={handleTriggerKeyDown}
        className="p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <Icon name="ellipsis-vertical" size="sm" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 top-full mt-1 w-48 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg z-30 py-1"
        >
          {items.map((item, idx) => {
            const disabled = item.disabled ? item.disabled(row) : false;
            const onSelect = () => {
              if (disabled) return;
              close();
              if (item.onClick) item.onClick(row);
            };
            const colorClass = item.destructive
              ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30 focus:bg-red-50 dark:focus:bg-red-900/30'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700';
            return (
              <button
                key={item.id}
                ref={el => (itemRefs.current[idx] = el)}
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={onSelect}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${colorClass}`}
              >
                {item.icon && <Icon name={item.icon} size="sm" />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default DataTableKebabMenu;
