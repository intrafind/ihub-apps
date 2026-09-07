import { useId } from 'react';

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
  rows,
  suggestions
}) {
  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';
  const datalistId = useId();

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

  if (type === 'range') {
    const numericValue = typeof value === 'number' ? value : Number(value) || min || 0;
    return (
      <div>
        <label className={labelClass}>
          {label}
          <span className="float-right font-mono text-gray-500 dark:text-gray-400">
            {numericValue}
          </span>
        </label>
        <input
          type="range"
          value={numericValue}
          onChange={e => onChange(Number(e.target.value))}
          min={min}
          max={max}
          step={step || 1}
          className="w-full accent-blue-600"
        />
        {helpText && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{helpText}</p>}
      </div>
    );
  }

  // Guard against object/array values reaching a scalar input — they'd render
  // as "[object Object]" and silently corrupt the field on edit. Show a JSON
  // preview and direct the user to the JSON tab instead.
  // Objects and arrays have no scalar rendering: a plain input shows
  // "[object Object]" and the first keystroke replaces the structure with a
  // string. Textareas are included — they are just as lossy. Forms that
  // legitimately edit structured values should use JsonField instead.
  const isComplex = type !== 'select' && value !== null && typeof value === 'object';
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
          Structured value — edit via the JSON tab.
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
        <>
          <input
            type={type}
            value={value ?? ''}
            onChange={e => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
            placeholder={placeholder}
            min={min}
            max={max}
            step={step}
            list={Array.isArray(suggestions) && suggestions.length > 0 ? datalistId : undefined}
            className={inputClass}
          />
          {Array.isArray(suggestions) && suggestions.length > 0 && (
            <datalist id={datalistId}>
              {suggestions.map(s => (
                <option
                  key={typeof s === 'string' ? s : s.value}
                  value={typeof s === 'string' ? s : s.value}
                >
                  {typeof s === 'string' ? undefined : s.label}
                </option>
              ))}
            </datalist>
          )}
        </>
      )}
      {helpText && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{helpText}</p>}
    </div>
  );
}

export default FormField;
