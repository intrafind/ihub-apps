import { useEffect, useState } from 'react';
import Icon from '../../../../../shared/components/Icon';

/**
 * Debounced search input. Controlled by `value` from the page (typically backed
 * by `useFilterState`), but debounces local typing so URL updates aren't fired
 * on every keystroke.
 */
function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  debounceMs = 200,
  className = '',
  autoFocus = false,
  ariaLabel
}) {
  const [local, setLocal] = useState(value);

  // Sync external value into the local debounced state.
  // eslint-disable-next-line @eslint-react/set-state-in-effect
  useEffect(() => setLocal(value), [value]);

  useEffect(() => {
    if (local === value) return undefined;
    const id = setTimeout(() => onChange(local), debounceMs);
    return () => clearTimeout(id);
  }, [local, value, onChange, debounceMs]);

  return (
    <div className={`relative inline-flex w-full sm:w-64 ${className}`}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500">
        <Icon name="search" size="sm" />
      </span>
      <input
        type="search"
        value={local}
        onChange={e => setLocal(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        autoFocus={autoFocus}
        className="w-full pl-8 pr-8 py-2 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      {local && (
        <button
          type="button"
          onClick={() => {
            setLocal('');
            onChange('');
          }}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-300"
        >
          <Icon name="x" size="sm" />
        </button>
      )}
    </div>
  );
}

export default SearchInput;
