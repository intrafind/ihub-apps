import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const primaryButton =
  'shrink-0 inline-flex h-10 items-center justify-center gap-1.5 px-4 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 whitespace-nowrap';

/**
 * The library's "New" action. One kind of item to create: a plain button
 * ("New prompt"). Several kinds: a small menu ("New prompt", "New skill", …).
 * The entries are data, so another kind of library item is one more entry.
 *
 * @param {Object} props
 * @param {Array<{id: string, label: string, icon?: string, itemType?: string, onSelect: () => void}>} props.entries
 *   - What can be created, in menu order. `itemType` is the kind of item an
 *   entry creates when that differs from its id (e.g. a skill from the marketplace).
 * @param {string} [props.className] - Extra classes for the wrapper.
 */
function LibraryNewMenu({ entries, className = '' }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
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
    if (open) itemsRef.current[0]?.focus();
  }, [open]);

  if (!Array.isArray(entries) || entries.length === 0) return null;

  if (entries.length === 1) {
    const [entry] = entries;
    return (
      <button type="button" onClick={entry.onSelect} className={`${primaryButton} ${className}`}>
        <Icon name="plus" size="sm" />
        {entry.label}
      </button>
    );
  }

  const close = ({ refocus = false } = {}) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKeyDown = event => {
    const items = itemsRef.current.filter(Boolean);
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ refocus: true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      close();
    }
  };

  return (
    <div ref={wrapperRef} className={`relative shrink-0 ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className={`${primaryButton} w-full`}
      >
        <Icon name="plus" size="sm" />
        {t('library.new.label', 'New')}
        <Icon name="chevron-down" size="sm" />
      </button>
      {open && (
        <ul
          role="menu"
          aria-label={t('library.new.label', 'New')}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-20 mt-1 min-w-[11rem] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1"
        >
          {entries.map((entry, index) => (
            <li key={entry.id} role="none">
              <button
                ref={element => {
                  itemsRef.current[index] = element;
                }}
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  entry.onSelect();
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-hidden inline-flex items-center gap-2"
              >
                <Icon name={entry.icon || 'plus'} size="sm" className="text-gray-500" />
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default LibraryNewMenu;
