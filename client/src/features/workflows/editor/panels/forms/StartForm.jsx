import { useState } from 'react';
import LocalizedField from './LocalizedField';

const TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'array', label: 'Array' },
  { value: 'object', label: 'Object' }
];

function StartForm({ config, onChange }) {
  const vars = Array.isArray(config.inputVariables) ? config.inputVariables : [];

  const updateVar = (index, field, value) => {
    const updated = vars.map((v, i) => (i === index ? { ...v, [field]: value } : v));
    onChange({ ...config, inputVariables: updated });
  };

  const addVar = () => {
    onChange({
      ...config,
      inputVariables: [...vars, { name: '', type: 'string', required: false, description: '' }]
    });
  };

  const removeVar = index => {
    onChange({ ...config, inputVariables: vars.filter((_, i) => i !== index) });
  };

  const [defaultsText, setDefaultsText] = useState(() => {
    try {
      return config.defaults ? JSON.stringify(config.defaults, null, 2) : '';
    } catch {
      return '';
    }
  });

  const handleDefaultsChange = text => {
    setDefaultsText(text);
    if (!text.trim()) {
      onChange({ ...config, defaults: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      onChange({ ...config, defaults: parsed });
    } catch {
      // invalid JSON, keep text but don't update config
    }
  };

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass}>Input Variables</label>
        <div className="space-y-2">
          {vars.map((v, index) => (
            <div
              key={index}
              className="border border-gray-200 dark:border-gray-700 rounded p-2 space-y-1.5"
            >
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={v.name || ''}
                  onChange={e => updateVar(index, 'name', e.target.value)}
                  placeholder="Variable name"
                  className={`flex-1 ${inputClass}`}
                />
                <select
                  value={v.type || 'string'}
                  onChange={e => updateVar(index, 'type', e.target.value)}
                  className={`w-24 ${inputClass}`}
                >
                  {TYPE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 shrink-0">
                  <input
                    type="checkbox"
                    checked={!!v.required}
                    onChange={e => updateVar(index, 'required', e.target.checked)}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  Req
                </label>
                <button
                  type="button"
                  onClick={() => removeVar(index)}
                  className="text-red-500 hover:text-red-700 dark:hover:text-red-400 p-1 text-sm shrink-0"
                  aria-label="Remove variable"
                >
                  &#x2715;
                </button>
              </div>
              <LocalizedField
                label="Description"
                rows={2}
                value={v.description}
                onChange={val => updateVar(index, 'description', val)}
                placeholder="Variable description..."
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addVar}
          className="mt-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 flex items-center gap-1"
        >
          <span>+</span> Add variable
        </button>
      </div>

      <div>
        <label className={labelClass}>Defaults (JSON)</label>
        <textarea
          value={defaultsText}
          onChange={e => handleDefaultsChange(e.target.value)}
          rows={4}
          placeholder='{"key": "default value"}'
          className={`${inputClass} font-mono`}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Default values for workflow state variables
        </p>
      </div>
    </div>
  );
}

export default StartForm;
