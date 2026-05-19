import FormField from './FormField';

function LoopForm({ config, onChange }) {
  const mode = config.mode || 'for';

  return (
    <div className="space-y-3">
      <FormField
        label="Mode"
        type="select"
        value={mode}
        onChange={v => onChange({ ...config, mode: v })}
        options={[
          { value: 'for', label: 'for' },
          { value: 'forEach', label: 'forEach' },
          { value: 'while', label: 'while' }
        ]}
      />
      {mode === 'for' && (
        <FormField
          label="Count"
          type="number"
          value={config.count}
          onChange={v => onChange({ ...config, count: v })}
          min={1}
        />
      )}
      {mode === 'forEach' && (
        <FormField
          label="Array"
          value={config.array}
          onChange={v => onChange({ ...config, array: v })}
          placeholder="e.g. ${items}"
        />
      )}
      {mode === 'while' && (
        <FormField
          label="Condition"
          type="textarea"
          rows={3}
          value={config.condition}
          onChange={v => onChange({ ...config, condition: v })}
          placeholder="Loop condition..."
        />
      )}
      <FormField
        label="Max Iterations"
        type="number"
        value={config.maxIterations}
        onChange={v => onChange({ ...config, maxIterations: v })}
        min={1}
      />
      <FormField
        label="Output Variable"
        value={config.outputVariable}
        onChange={v => onChange({ ...config, outputVariable: v })}
        placeholder="e.g. loopResults"
      />
    </div>
  );
}

export default LoopForm;
