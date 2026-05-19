import FormField from './FormField';

function MemoryForm({ config, onChange }) {
  const operation = config.operation || 'get';

  return (
    <div className="space-y-3">
      <FormField
        label="Operation"
        type="select"
        value={operation}
        onChange={v => onChange({ ...config, operation: v })}
        options={[
          { value: 'get', label: 'get' },
          { value: 'set', label: 'set' },
          { value: 'delete', label: 'delete' }
        ]}
      />
      <FormField
        label="Key"
        value={config.key}
        onChange={v => onChange({ ...config, key: v })}
        placeholder="Memory key"
      />
      {operation === 'set' && (
        <FormField
          label="Value"
          type="textarea"
          rows={4}
          value={config.value}
          onChange={v => onChange({ ...config, value: v })}
          placeholder="Value to store..."
        />
      )}
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. memoryValue"
      />
    </div>
  );
}

export default MemoryForm;
