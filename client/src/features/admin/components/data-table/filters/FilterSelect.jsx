/**
 * Labeled <select> for filter rows. Controlled by `value` from the page,
 * typically backed by `useFilterState`.
 */
function FilterSelect({ label, value, onChange, options, className = '', ariaLabel }) {
  return (
    <label
      className={`inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 ${className}`}
    >
      {label && <span>{label}</span>}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-label={ariaLabel || label}
        className="text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default FilterSelect;
