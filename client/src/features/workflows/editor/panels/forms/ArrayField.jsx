function ArrayField({ label, value = [], onChange, placeholder }) {
  const items = Array.isArray(value) ? value : [];

  const handleChange = (index, newVal) => {
    const updated = [...items];
    updated[index] = newVal;
    onChange(updated);
  };

  const handleRemove = index => {
    onChange(items.filter((_, i) => i !== index));
  };

  const handleAdd = () => {
    onChange([...items, '']);
  };

  return (
    <div>
      {label && (
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
          {label}
        </label>
      )}
      <div className="space-y-1.5">
        {items.map((item, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              type="text"
              value={item}
              onChange={e => handleChange(index, e.target.value)}
              placeholder={placeholder}
              className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            />
            <button
              type="button"
              onClick={() => handleRemove(index)}
              className="text-red-500 hover:text-red-700 dark:hover:text-red-400 p-1 text-sm shrink-0"
              aria-label="Remove item"
            >
              &#x2715;
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={handleAdd}
        className="mt-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 flex items-center gap-1"
      >
        <span>+</span> Add
      </button>
    </div>
  );
}

export default ArrayField;
