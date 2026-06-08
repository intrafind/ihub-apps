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
        {items.map((item, index) => {
          const isComplex = item !== null && typeof item === 'object';
          let complexPreview = '';
          if (isComplex) {
            try {
              complexPreview = JSON.stringify(item, null, 2);
            } catch {
              complexPreview = String(item);
            }
          }
          return (
            <div key={index} className="flex items-start gap-1.5">
              {isComplex ? (
                <pre className="flex-1 text-xs font-mono border border-amber-300 dark:border-amber-700 rounded px-2 py-1.5 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                  {complexPreview}
                </pre>
              ) : (
                <input
                  type="text"
                  value={item ?? ''}
                  onChange={e => handleChange(index, e.target.value)}
                  placeholder={placeholder}
                  className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                />
              )}
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="text-red-500 hover:text-red-700 dark:hover:text-red-400 p-1 text-sm shrink-0"
                aria-label="Remove item"
              >
                &#x2715;
              </button>
            </div>
          );
        })}
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
