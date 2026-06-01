import { useEffect, useRef, useState } from 'react';
import Icon from '../../../../shared/components/Icon';

/**
 * Vertical-dots popover for row overflow actions.
 * Hand-rolled mousedown click-outside to match `ArtifactDownloadMenu` convention.
 */
function DataTableKebabMenu({ items, label = 'More actions', row }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!items || items.length === 0) return null;

  return (
    <div className="relative inline-block" ref={ref} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(v => !v)}
        className="p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <Icon name="ellipsis-vertical" size="sm" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-48 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg z-30 py-1"
        >
          {items.map(item => {
            const disabled = item.disabled ? item.disabled(row) : false;
            const onSelect = () => {
              if (disabled) return;
              setOpen(false);
              if (item.onClick) item.onClick(row);
            };
            const colorClass = item.destructive
              ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700';
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={onSelect}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-50 disabled:cursor-not-allowed ${colorClass}`}
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
