function FormField({
  label,
  type = 'text',
  value,
  onChange,
  options,
  placeholder,
  helpText,
  min,
  max,
  step,
  rows
}) {
  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  if (type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!value}
          onChange={e => onChange(e.target.checked)}
          className="rounded border-gray-300 dark:border-gray-600"
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      </label>
    );
  }

  // Guard against object/array values reaching a scalar input — they'd render
  // as "[object Object]" and silently corrupt the field on edit. Show a JSON
  // preview and direct the user to the JSON tab instead.
  const isComplex =
    type !== 'select' && type !== 'textarea' && value !== null && typeof value === 'object';
  if (isComplex) {
    let preview;
    try {
      preview = JSON.stringify(value, null, 2);
    } catch {
      preview = String(value);
    }
    return (
      <div>
        <label className={labelClass}>{label}</label>
        <pre className="w-full text-xs font-mono border border-amber-300 dark:border-amber-700 rounded px-2 py-1.5 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
          {preview}
        </pre>
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
          Complex value — edit via the JSON tab.
        </p>
      </div>
    );
  }

  return (
    <div>
      <label className={labelClass}>{label}</label>
      {type === 'textarea' ? (
        <textarea
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          rows={rows || 4}
          placeholder={placeholder}
          className={`${inputClass} font-mono`}
        />
      ) : type === 'select' ? (
        <select value={value ?? ''} onChange={e => onChange(e.target.value)} className={inputClass}>
          {(options || []).map(opt => (
            <option key={opt.value ?? opt} value={opt.value ?? opt}>
              {opt.label ?? opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          value={value ?? ''}
          onChange={e => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
          placeholder={placeholder}
          min={min}
          max={max}
          step={step}
          className={inputClass}
        />
      )}
      {helpText && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{helpText}</p>}
    </div>
  );
}

export default FormField;
