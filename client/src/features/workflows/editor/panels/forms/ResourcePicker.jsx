import { useState, useRef, useEffect } from 'react';

/**
 * Compact searchable picker for platform resources (tools, models, sources).
 *
 * @param {object} props
 * @param {string} props.label - Field label
 * @param {Function} props.fetchFn - Async function returning array of { id, name, description? }
 * @param {string|string[]} props.value - Selected ID (single) or IDs (multi)
 * @param {Function} props.onChange - Callback with selected ID(s)
 * @param {boolean} [props.multi=false] - Multi-select mode
 * @param {string} [props.placeholder] - Search placeholder
 * @param {Function} [props.getItemLabel] - Custom label extractor (item) => string
 */
function ResourcePicker({
  label,
  fetchFn,
  value,
  onChange,
  multi = false,
  placeholder = 'Search...',
  getItemLabel
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const data = await fetchFn();
        if (!cancelled) setItems(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [fetchFn]);

  useEffect(() => {
    const handleClick = e => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const itemLabel = item => {
    if (getItemLabel) return getItemLabel(item);
    if (typeof item.name === 'object')
      return item.name.en || Object.values(item.name)[0] || item.id;
    return item.name || item.id;
  };

  const selectedIds = multi ? (Array.isArray(value) ? value : []) : [];
  const selectedId = multi ? null : value || '';

  const filtered = items.filter(item => {
    if (multi && selectedIds.includes(item.id)) return false;
    if (!multi && selectedId === item.id) return false;
    if (!search) return true;
    const text = `${itemLabel(item)} ${item.id}`.toLowerCase();
    return text.includes(search.toLowerCase());
  });

  const handleSelect = item => {
    if (multi) {
      onChange([...selectedIds, item.id]);
    } else {
      onChange(item.id);
    }
    setSearch('');
    setOpen(false);
  };

  const handleRemove = id => {
    if (multi) {
      onChange(selectedIds.filter(i => i !== id));
    } else {
      onChange('');
    }
  };

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  const renderTags = ids =>
    ids.map(id => {
      const item = items.find(i => i.id === id);
      return (
        <span
          key={id}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300"
        >
          {item ? itemLabel(item) : id}
          <button
            type="button"
            onClick={() => handleRemove(id)}
            className="text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"
            aria-label={`Remove ${id}`}
          >
            &#x2715;
          </button>
        </span>
      );
    });

  return (
    <div ref={ref}>
      <label className={labelClass}>{label}</label>

      {/* Selected tags (multi) or selected value (single) */}
      {multi && selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">{renderTags(selectedIds)}</div>
      )}
      {!multi && selectedId && (
        <div className="flex flex-wrap gap-1 mb-1">{renderTags([selectedId])}</div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Enter' && filtered.length > 0) {
              handleSelect(filtered[0]);
              e.preventDefault();
            }
            if (e.key === 'Escape') {
              setOpen(false);
              setSearch('');
            }
          }}
          placeholder={placeholder}
          className={inputClass}
          autoComplete="off"
        />

        {/* Dropdown */}
        {open && (
          <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-lg max-h-48 overflow-auto">
            {loading ? (
              <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">Loading...</div>
            ) : filtered.length > 0 ? (
              filtered.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelect(item)}
                  className="w-full text-left px-2 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                >
                  <div className="font-medium text-gray-900 dark:text-gray-100 text-xs">
                    {itemLabel(item)}
                  </div>
                  {item.id !== itemLabel(item) && (
                    <div className="text-xs text-gray-400 dark:text-gray-500">{item.id}</div>
                  )}
                </button>
              ))
            ) : (
              <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
                {search ? 'No matches' : 'No items available'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ResourcePicker;
