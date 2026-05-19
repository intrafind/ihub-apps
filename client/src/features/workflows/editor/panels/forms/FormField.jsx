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
