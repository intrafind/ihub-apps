import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';

// Above this many options the popover grows a type-ahead box.
const SEARCH_THRESHOLD = 10;

/**
 * FilterMultiSelect — checkbox filter for a table's filter row.
 *
 * A trigger button showing how much of the vocabulary is currently selected,
 * opening a popover with one checkbox per option (each with its entry count),
 * plus **Select all** / **Select none** and, for long lists, a type-ahead.
 *
 * The control is fully controlled: it never derives state from its own
 * interactions. `selected` is the list of currently selected option values and
 * `onChange` receives the complete next list, so the page decides how that maps
 * onto its URL parameters.
 *
 * Options are usually server-computed facets, so an option's `count` tells the
 * admin what a checkbox is worth before they untick it.
 *
 * @param {object} props
 * @param {string} props.label - Field label rendered above the trigger
 * @param {Array<{value: string, label?: string, count?: number}>} props.options - Available values
 * @param {string[]} props.selected - Currently selected option values
 * @param {(next: string[]) => void} props.onChange - Receives the full next selection
 * @param {string} [props.allLabel] - Trigger text when everything is selected
 * @param {string} [props.noneLabel] - Trigger text when nothing is selected
 * @param {string} [props.searchPlaceholder] - Type-ahead placeholder
 * @param {string} [props.emptyLabel] - Shown when there are no options at all
 * @param {boolean} [props.disabled=false]
 * @param {string} [props.className]
 */
function FilterMultiSelect({
  label,
  options = [],
  selected = [],
  onChange,
  allLabel,
  noneLabel,
  searchPlaceholder,
  emptyLabel,
  disabled = false,
  className = ''
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = options.length > 0 && selectedSet.size >= options.length;
  const noneSelected = selectedSet.size === 0;

  const showSearch = options.length > SEARCH_THRESHOLD;
  const visibleOptions = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(o =>
      String(o.label ?? o.value)
        .toLowerCase()
        .includes(needle)
    );
  }, [options, term]);

  const close = useCallback(() => {
    setOpen(false);
    setTerm('');
    triggerRef.current?.focus();
  }, []);

  // Dismiss on click outside. Registered only while open.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (!containerRef.current?.contains(event.target)) {
        setOpen(false);
        setTerm('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Move focus into the popover so the keyboard path works without a mouse.
  useEffect(() => {
    if (!open) return;
    const target = showSearch
      ? searchRef.current
      : listRef.current?.querySelector('input[type="checkbox"]');
    target?.focus();
  }, [open, showSearch]);

  const toggleValue = value => {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    // Preserve the option order rather than the click order, so the emitted
    // list is stable and comparable.
    onChange?.(options.filter(o => next.has(o.value)).map(o => o.value));
  };

  // Arrow keys move between checkboxes, Escape closes and returns focus. Bound
  // natively on the container while open so it catches keys from the
  // type-ahead box and the select-all/none buttons as well.
  useEffect(() => {
    if (!open) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const boxes = Array.from(
        listRef.current?.querySelectorAll('input[type="checkbox"]:not([disabled])') ?? []
      );
      if (boxes.length === 0) return;
      event.preventDefault();
      const current = boxes.indexOf(document.activeElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = current === -1 ? 0 : (current + delta + boxes.length) % boxes.length;
      boxes[next].focus();
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const triggerText = allSelected
    ? (allLabel ?? t('admin.filters.multiSelect.all', 'All'))
    : noneSelected
      ? (noneLabel ?? t('admin.filters.multiSelect.none', 'None'))
      : t('admin.filters.multiSelect.someSelected', '{{selected}} of {{total}}', {
          selected: selectedSet.size,
          total: options.length
        });

  const filtered = !allSelected;

  return (
    <div className={className} ref={containerRef}>
      {/* A plain span, not a <label>: the trigger's accessible name is built
          from the field name *and* the button's own text via aria-labelledby,
          so a screen reader announces "Action, 3 of 8". */}
      <span
        id={`${baseId}-label`}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {label}
      </span>
      <div className="relative">
        <button
          id={`${baseId}-trigger`}
          ref={triggerRef}
          type="button"
          disabled={disabled || options.length === 0}
          onClick={() => setOpen(v => !v)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' && !open) {
              event.preventDefault();
              setOpen(true);
            }
          }}
          // No aria-haspopup: this is a disclosure, not a menu or a dialog, and
          // the value would have to name the popup's actual role. aria-expanded
          // alone describes it correctly.
          aria-expanded={open}
          aria-labelledby={`${baseId}-label ${baseId}-trigger`}
          className={`w-full inline-flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 ${
            filtered
              ? 'border-indigo-400 dark:border-indigo-500'
              : 'border-gray-300 dark:border-gray-600'
          }`}
        >
          <span className="truncate">
            {options.length === 0
              ? (emptyLabel ?? t('admin.filters.multiSelect.noOptions', 'No values'))
              : triggerText}
          </span>
          <Icon name="chevron-down" size="sm" className="flex-shrink-0 text-gray-400" />
        </button>

        {open && (
          <div
            role="group"
            aria-labelledby={`${baseId}-label`}
            className="absolute z-20 mt-1 w-full min-w-[14rem] rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-700">
              <button
                type="button"
                onClick={() => onChange?.(options.map(o => o.value))}
                disabled={allSelected}
                className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-40 disabled:no-underline"
              >
                {t('admin.filters.multiSelect.selectAll', 'Select all')}
              </button>
              <button
                type="button"
                onClick={() => onChange?.([])}
                disabled={noneSelected}
                className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-40 disabled:no-underline"
              >
                {t('admin.filters.multiSelect.selectNone', 'Select none')}
              </button>
            </div>

            {showSearch && (
              <div className="px-2 pt-2">
                <input
                  ref={searchRef}
                  type="search"
                  value={term}
                  onChange={e => setTerm(e.target.value)}
                  placeholder={
                    searchPlaceholder ?? t('admin.filters.multiSelect.search', 'Filter…')
                  }
                  aria-label={searchPlaceholder ?? t('admin.filters.multiSelect.search', 'Filter…')}
                  className="w-full rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            )}

            <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
              {visibleOptions.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.filters.multiSelect.noMatches', 'No matching values')}
                </p>
              ) : (
                visibleOptions.map(option => (
                  <label
                    key={option.value}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(option.value)}
                      onChange={() => toggleValue(option.value)}
                      className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="flex-1 truncate">{option.label ?? option.value}</span>
                    {option.count !== undefined && (
                      <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                        {option.count}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default FilterMultiSelect;
