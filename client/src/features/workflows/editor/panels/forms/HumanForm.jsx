import FormField from './FormField';
import LocalizedField from './LocalizedField';

const STYLE_OPTIONS = [
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'danger', label: 'Danger' }
];

function HumanForm({ config, onChange }) {
  const options = Array.isArray(config.options) ? config.options : [];

  const updateOption = (index, field, value) => {
    const updated = options.map((opt, i) => (i === index ? { ...opt, [field]: value } : opt));
    onChange({ ...config, options: updated });
  };

  const addOption = () => {
    onChange({
      ...config,
      options: [...options, { value: '', label: '', style: 'primary' }]
    });
  };

  const removeOption = index => {
    onChange({ ...config, options: options.filter((_, i) => i !== index) });
  };

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  return (
    <div className="space-y-3">
      <LocalizedField
        label="Message"
        rows={4}
        value={config.message}
        onChange={v => onChange({ ...config, message: v })}
        placeholder="What should the user be asked?"
      />
      <div>
        <label className={labelClass}>Options</label>
        <div className="space-y-2">
          {options.map((opt, index) => (
            <div
              key={index}
              className="border border-gray-200 dark:border-gray-700 rounded p-2 flex items-center gap-1.5"
            >
              <input
                type="text"
                value={opt.value || ''}
                onChange={e => updateOption(index, 'value', e.target.value)}
                placeholder="Value"
                className={`flex-1 ${inputClass}`}
              />
              <input
                type="text"
                value={opt.label || ''}
                onChange={e => updateOption(index, 'label', e.target.value)}
                placeholder="Label"
                className={`flex-1 ${inputClass}`}
              />
              <select
                value={opt.style || 'primary'}
                onChange={e => updateOption(index, 'style', e.target.value)}
                className={`w-28 ${inputClass}`}
              >
                {STYLE_OPTIONS.map(s => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeOption(index)}
                className="text-red-500 hover:text-red-700 dark:hover:text-red-400 p-1 text-sm shrink-0"
                aria-label="Remove option"
              >
                &#x2715;
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addOption}
          className="mt-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 flex items-center gap-1"
        >
          <span>+</span> Add option
        </button>
      </div>
      <FormField
        label="Timeout (ms)"
        type="number"
        value={config.timeout}
        onChange={v => onChange({ ...config, timeout: v })}
        min={1000}
        step={1000}
        placeholder="ms"
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. userResponse"
      />
    </div>
  );
}

export default HumanForm;
