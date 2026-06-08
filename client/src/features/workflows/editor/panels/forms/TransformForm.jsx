import { useState, useEffect } from 'react';

const OP_TYPES = [
  { value: 'set', label: 'Set' },
  { value: 'copy', label: 'Copy' },
  { value: 'push', label: 'Push' },
  { value: 'increment', label: 'Increment' },
  { value: 'merge', label: 'Merge' },
  { value: 'arrayGet', label: 'Array Get' },
  { value: 'lengthOf', label: 'Length Of' },
  { value: 'condition', label: 'Condition' }
];

const OP_TYPE_KEYS = OP_TYPES.map(t => t.value);

/**
 * Server format uses the operation type as a key, e.g.:
 *   { copy: "source.path", to: "target.path" }
 *   { set: "state.result", value: "hello" }
 * Detect which key is the operation type.
 */
function detectOpType(op) {
  for (const key of OP_TYPE_KEYS) {
    if (key in op) return key;
  }
  return 'set';
}

/**
 * Field definitions for each operation type.
 * `primaryLabel` describes the type-key's value.
 * `fields` are the additional fields.
 */
const OP_FIELDS = {
  set: {
    primaryLabel: 'Path',
    primaryPlaceholder: 'e.g. state.result',
    fields: [{ key: 'value', label: 'Value', placeholder: 'Value or expression' }]
  },
  copy: {
    primaryLabel: 'From',
    primaryPlaceholder: 'e.g. state.input',
    fields: [{ key: 'to', label: 'To', placeholder: 'e.g. state.output' }]
  },
  push: {
    primaryLabel: 'Item',
    primaryPlaceholder: 'Value to push',
    fields: [{ key: 'to', label: 'Array Path', placeholder: 'e.g. state.items' }]
  },
  increment: {
    primaryLabel: 'Path',
    primaryPlaceholder: 'e.g. state.counter',
    fields: [{ key: 'by', label: 'By', placeholder: '1', type: 'number' }]
  },
  merge: {
    primaryLabel: 'Source',
    primaryPlaceholder: 'e.g. state.data',
    fields: [{ key: 'into', label: 'Into', placeholder: 'e.g. state.merged' }]
  },
  arrayGet: {
    primaryLabel: 'Array Path',
    primaryPlaceholder: 'e.g. state.items',
    fields: [
      { key: 'index', label: 'Index', placeholder: '0', type: 'number' },
      { key: 'to', label: 'To', placeholder: 'e.g. state.item' }
    ]
  },
  lengthOf: {
    primaryLabel: 'Array Path',
    primaryPlaceholder: 'e.g. state.items',
    fields: [{ key: 'to', label: 'To', placeholder: 'e.g. state.count' }]
  },
  condition: {
    primaryLabel: 'Condition',
    primaryPlaceholder: 'Condition expression',
    fields: [
      { key: 'then', label: 'Then', placeholder: 'Value if true' },
      { key: 'else', label: 'Else', placeholder: 'Value if false' },
      { key: 'to', label: 'To', placeholder: 'e.g. state.result' }
    ]
  }
};

/**
 * Field that accepts either a scalar string/number or a JSON-encoded object/array.
 * Object values would otherwise render as "[object Object]" in a plain input and
 * silently get corrupted on edit. When the current value is complex, we render
 * a JSON textarea (parse-on-blur); otherwise a plain input.
 */
function SmartValueField({ label, value, onChange, placeholder, scalarType = 'text' }) {
  const isComplex = value !== null && typeof value === 'object';
  const [jsonText, setJsonText] = useState(() => {
    if (!isComplex) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  });
  const [parseError, setParseError] = useState(null);

  useEffect(() => {
    if (isComplex) {
      try {
        setJsonText(JSON.stringify(value, null, 2));
        setParseError(null);
      } catch {
        // ignore
      }
    }
  }, [value, isComplex]);

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';

  const handleJsonChange = text => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      onChange(parsed);
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <label className="block text-xs text-gray-500 dark:text-gray-400">{label}</label>
        {!isComplex && (
          <button
            type="button"
            onClick={() => onChange({})}
            className="text-[10px] text-blue-500 hover:text-blue-600"
            title="Switch to JSON value (object/array)"
          >
            {}
          </button>
        )}
        {isComplex && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-[10px] text-gray-500 hover:text-gray-700"
            title="Switch back to scalar value"
          >
            abc
          </button>
        )}
      </div>
      {isComplex ? (
        <>
          <textarea
            value={jsonText}
            onChange={e => handleJsonChange(e.target.value)}
            rows={6}
            className={`${inputClass} font-mono`}
            placeholder="JSON value"
          />
          {parseError && <p className="text-xs text-red-500 mt-0.5">{parseError}</p>}
        </>
      ) : (
        <input
          type={scalarType}
          value={value ?? ''}
          onChange={e =>
            onChange(scalarType === 'number' ? Number(e.target.value) : e.target.value)
          }
          placeholder={placeholder}
          className={inputClass}
        />
      )}
    </div>
  );
}

function TransformForm({ config, onChange }) {
  const operations = Array.isArray(config.operations) ? config.operations : [];

  const updateOp = (index, field, value) => {
    const updated = operations.map((op, i) => (i === index ? { ...op, [field]: value } : op));
    onChange({ ...config, operations: updated });
  };

  const updatePrimary = (index, opType, value) => {
    const updated = operations.map((op, i) => (i === index ? { ...op, [opType]: value } : op));
    onChange({ ...config, operations: updated });
  };

  const changeOpType = (index, newType) => {
    const updated = operations.map((op, i) => {
      if (i !== index) return op;
      const oldType = detectOpType(op);
      // Remove old type key, add new type key with the old primary value
      const { [oldType]: oldValue, ...rest } = op;
      return { [newType]: oldValue || '', ...rest };
    });
    onChange({ ...config, operations: updated });
  };

  const addOp = () => {
    onChange({ ...config, operations: [...operations, { set: '' }] });
  };

  const removeOp = index => {
    onChange({ ...config, operations: operations.filter((_, i) => i !== index) });
  };

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  return (
    <div className="space-y-3">
      <label className={labelClass}>Operations</label>
      <div className="space-y-2">
        {operations.map((op, index) => {
          const opType = detectOpType(op);
          const spec = OP_FIELDS[opType] || OP_FIELDS.set;
          return (
            <div
              key={index}
              className="border border-gray-200 dark:border-gray-700 rounded p-2 space-y-1.5"
            >
              <div className="flex items-center gap-1.5">
                <select
                  value={opType}
                  onChange={e => changeOpType(index, e.target.value)}
                  className={`flex-1 ${inputClass}`}
                >
                  {OP_TYPES.map(t => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeOp(index)}
                  className="text-red-500 hover:text-red-700 dark:hover:text-red-400 p-1 text-sm shrink-0"
                  aria-label="Remove operation"
                >
                  &#x2715;
                </button>
              </div>
              {/* Primary field: the value of the type key */}
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">
                  {spec.primaryLabel}
                </label>
                <input
                  type="text"
                  value={op[opType] ?? ''}
                  onChange={e => updatePrimary(index, opType, e.target.value)}
                  placeholder={spec.primaryPlaceholder}
                  className={inputClass}
                />
              </div>
              {/* Secondary fields */}
              {spec.fields.map(f => (
                <SmartValueField
                  key={f.key}
                  label={f.label}
                  value={op[f.key]}
                  onChange={val => updateOp(index, f.key, val)}
                  placeholder={f.placeholder}
                  scalarType={f.type || 'text'}
                />
              ))}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={addOp}
        className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 flex items-center gap-1"
      >
        <span>+</span> Add operation
      </button>
    </div>
  );
}

export default TransformForm;
