import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * GroupMultiSelect - Searchable multi-select for group names.
 *
 * Lets admins search and pick from known groups (so they choose the right ones)
 * while still allowing free-form entry of names for non-existing groups. The
 * latter is required because the same control is used to add external group
 * mappings (e.g. OIDC/LDAP group names) that are not defined as internal groups.
 *
 * Selected values are stored as plain strings (group id for known groups, the
 * raw name for custom/external entries). Known and custom entries are rendered
 * differently so it is obvious which values resolve to a defined group.
 *
 * @param {object} props
 * @param {string} [props.label] - Field label
 * @param {string} [props.id] - Base id used for accessibility wiring
 * @param {string[]} props.value - Currently selected group names/ids
 * @param {(next: string[]) => void} props.onChange - Selection change handler
 * @param {Array<{id: string, name?: string, description?: string}>} [props.availableGroups] - Known groups to suggest
 * @param {string} [props.placeholder] - Search input placeholder
 * @param {string} [props.helpText] - Helper text rendered below the control
 * @param {string} [props.emptyMessage] - Message shown when nothing is selected
 * @param {boolean} [props.allowCustom=true] - Allow adding names that are not known groups
 * @param {boolean} [props.warnOnCustom=true] - Visually flag entries that are not defined groups
 * @param {boolean} [props.disabled=false] - Disable the control
 */
function GroupMultiSelect({
  label,
  id = 'group-multi-select',
  value = [],
  onChange,
  availableGroups = [],
  placeholder,
  helpText,
  emptyMessage,
  allowCustom = true,
  warnOnCustom = true,
  disabled = false
}) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selected = useMemo(() => (Array.isArray(value) ? value : []), [value]);

  // Normalize known groups to a consistent option shape.
  const options = useMemo(
    () =>
      (availableGroups || [])
        .filter(g => g && (g.id || g.name))
        .map(g => ({
          id: String(g.id ?? g.name),
          name: g.name ? String(g.name) : String(g.id),
          description: g.description ? String(g.description) : ''
        })),
    [availableGroups]
  );

  // Lower-cased lookup set for case-insensitive de-duplication.
  const selectedKeys = useMemo(
    () => new Set(selected.map(v => String(v).toLowerCase())),
    [selected]
  );
  const isSelected = useCallback(
    candidate => selectedKeys.has(String(candidate).toLowerCase()),
    [selectedKeys]
  );

  // Resolve chips: match each selected value to a known group when possible.
  const selectedChips = useMemo(
    () =>
      selected.map(v => {
        const match = options.find(o => o.id.toLowerCase() === String(v).toLowerCase());
        return match
          ? { value: v, label: match.name, description: match.description, known: true }
          : { value: v, label: String(v), description: '', known: false };
      }),
    [selected, options]
  );

  // Filter known groups by search term, excluding already-selected ones.
  const filteredOptions = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return options.filter(o => {
      if (isSelected(o.id)) return false;
      if (!term) return true;
      return o.id.toLowerCase().includes(term) || o.name.toLowerCase().includes(term);
    });
  }, [options, searchTerm, isSelected]);

  const trimmedTerm = searchTerm.trim();
  const hasExactMatch = options.some(
    o =>
      o.id.toLowerCase() === trimmedTerm.toLowerCase() ||
      o.name.toLowerCase() === trimmedTerm.toLowerCase()
  );
  const showCustomOption =
    allowCustom && trimmedTerm.length > 0 && !hasExactMatch && !isSelected(trimmedTerm);

  // Combined, index-addressable list for keyboard navigation.
  const navItems = useMemo(() => {
    const items = filteredOptions.map(o => ({ type: 'group', option: o }));
    if (showCustomOption) items.push({ type: 'custom', term: trimmedTerm });
    return items;
  }, [filteredOptions, showCustomOption, trimmedTerm]);

  const commit = next => {
    onChange?.(next);
    setSearchTerm('');
    setActiveIndex(-1);
  };

  const addValue = candidate => {
    const val = String(candidate).trim();
    if (!val || isSelected(val)) {
      setSearchTerm('');
      setActiveIndex(-1);
      return;
    }
    commit([...selected, val]);
  };

  // Add by raw term: prefer the canonical id of a matching known group.
  const addTerm = term => {
    const val = String(term).trim();
    if (!val) return;
    const match = options.find(
      o => o.id.toLowerCase() === val.toLowerCase() || o.name.toLowerCase() === val.toLowerCase()
    );
    addValue(match ? match.id : val);
  };

  const removeValue = candidate => {
    commit(selected.filter(v => String(v) !== String(candidate)));
  };

  const openDropdown = () => {
    if (!disabled) setShowDropdown(true);
  };

  const handleSelectNavItem = item => {
    if (!item) return;
    if (item.type === 'group') {
      addValue(item.option.id);
    } else if (item.type === 'custom') {
      addTerm(item.term);
    }
    inputRef.current?.focus();
  };

  const handleKeyDown = e => {
    if (disabled) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setShowDropdown(true);
      setActiveIndex(prev => (navItems.length === 0 ? -1 : (prev + 1) % navItems.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev =>
        navItems.length === 0 ? -1 : (prev - 1 + navItems.length) % navItems.length
      );
      return;
    }
    if (e.key === 'Enter' || e.key === ',') {
      // Comma and Enter both commit the current entry.
      if (e.key === 'Enter' && activeIndex >= 0 && navItems[activeIndex]) {
        e.preventDefault();
        handleSelectNavItem(navItems[activeIndex]);
        return;
      }
      if (trimmedTerm) {
        e.preventDefault();
        addTerm(trimmedTerm);
      } else if (e.key === ',') {
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Escape') {
      setShowDropdown(false);
      setActiveIndex(-1);
      return;
    }
    if (e.key === 'Backspace' && searchTerm.length === 0 && selected.length > 0) {
      removeValue(selected[selected.length - 1]);
    }
  };

  const resolvedPlaceholder =
    placeholder ?? t('admin.groupSelect.placeholder', 'Search groups or type a name…');
  const resolvedEmpty = emptyMessage ?? t('admin.groupSelect.empty', 'No groups selected yet');
  const listboxId = `${id}-listbox`;

  return (
    <div className="space-y-2">
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
      )}

      {/* Selected chips */}
      <div className="min-h-[2rem]">
        {selectedChips.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {selectedChips.map(chip => {
              const flagged = !chip.known && warnOnCustom;
              return (
                <span
                  key={chip.value}
                  title={
                    chip.known
                      ? chip.description || t('admin.groupSelect.knownGroup', 'Defined group')
                      : flagged
                        ? t(
                            'admin.groupSelect.customGroup',
                            'Not a defined group — treated as an external group mapping'
                          )
                        : undefined
                  }
                  className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                    flagged
                      ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300'
                      : 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300'
                  }`}
                >
                  <Icon
                    name={flagged ? 'exclamation-triangle' : 'users'}
                    size="xs"
                    className="mr-1"
                  />
                  {chip.label}
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => removeValue(chip.value)}
                      className="ml-2 text-current hover:text-red-600 dark:hover:text-red-400 focus:outline-none"
                      aria-label={t('admin.groupSelect.remove', 'Remove {{name}}', {
                        name: chip.label
                      })}
                    >
                      <Icon name="x" size="sm" />
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">{resolvedEmpty}</p>
        )}
      </div>

      {/* Search / add input */}
      <div className="relative">
        <div className="relative">
          <input
            ref={inputRef}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={showDropdown}
            aria-controls={listboxId}
            aria-activedescendant={activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            disabled={disabled}
            value={searchTerm}
            onChange={e => {
              setSearchTerm(e.target.value);
              setShowDropdown(true);
              setActiveIndex(-1);
            }}
            onFocus={openDropdown}
            onBlur={() => setShowDropdown(false)}
            onKeyDown={handleKeyDown}
            placeholder={resolvedPlaceholder}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm placeholder-gray-400 dark:placeholder-gray-500 disabled:bg-gray-100 dark:disabled:bg-gray-700"
          />
          <Icon
            name="search"
            size="sm"
            className="absolute right-3 top-2.5 text-gray-400 dark:text-gray-500 pointer-events-none"
          />
        </div>

        {showDropdown && (
          <div
            id={listboxId}
            role="listbox"
            className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg max-h-60 rounded-md py-1 text-base ring-1 ring-black ring-opacity-5 dark:ring-gray-700 overflow-auto focus:outline-none sm:text-sm"
          >
            {navItems.length > 0 ? (
              navItems.map((item, index) => {
                const active = index === activeIndex;
                const optionId = `${id}-opt-${index}`;
                if (item.type === 'group') {
                  const { option } = item;
                  return (
                    <button
                      key={`group-${option.id}`}
                      id={optionId}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseDown={e => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => handleSelectNavItem(item)}
                      className={`w-full text-left px-4 py-2 focus:outline-none ${
                        active ? 'bg-gray-100 dark:bg-gray-700' : ''
                      }`}
                    >
                      <div className="flex items-center">
                        <Icon
                          name="plus"
                          size="sm"
                          className="mr-2 text-green-600 dark:text-green-400 flex-shrink-0"
                        />
                        <span className="text-gray-900 dark:text-gray-100">{option.name}</span>
                        {option.name.toLowerCase() !== option.id.toLowerCase() && (
                          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                            {option.id}
                          </span>
                        )}
                      </div>
                      {option.description && (
                        <p className="mt-0.5 ml-6 text-xs text-gray-500 dark:text-gray-400 truncate">
                          {option.description}
                        </p>
                      )}
                    </button>
                  );
                }
                return (
                  <button
                    key="custom-option"
                    id={optionId}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseDown={e => e.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => handleSelectNavItem(item)}
                    className={`w-full text-left px-4 py-2 border-t border-gray-100 dark:border-gray-700 focus:outline-none ${
                      active ? 'bg-gray-100 dark:bg-gray-700' : ''
                    }`}
                  >
                    <div className="flex items-center">
                      <Icon
                        name="plus"
                        size="sm"
                        className="mr-2 text-amber-600 dark:text-amber-400 flex-shrink-0"
                      />
                      <span className="text-gray-900 dark:text-gray-100">
                        {t('admin.groupSelect.addCustom', 'Add "{{name}}"', {
                          name: item.term
                        })}
                      </span>
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                {trimmedTerm
                  ? t('admin.groupSelect.noMatches', 'No matching groups')
                  : t('admin.groupSelect.startTyping', 'Start typing to search groups…')}
              </div>
            )}
          </div>
        )}
      </div>

      {helpText && <p className="text-xs text-gray-500 dark:text-gray-400">{helpText}</p>}
    </div>
  );
}

export default GroupMultiSelect;
