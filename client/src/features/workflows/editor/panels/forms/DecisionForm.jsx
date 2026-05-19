import FormField from './FormField';

function DecisionForm({ config, onChange }) {
  const type = config.type || 'expression';

  return (
    <div className="space-y-3">
      <FormField
        label="Type"
        type="select"
        value={type}
        onChange={v => onChange({ ...config, type: v })}
        options={[
          { value: 'expression', label: 'Expression' },
          { value: 'switch', label: 'Switch' }
        ]}
      />

      {type === 'expression' ? (
        <FormField
          label="Expression"
          type="textarea"
          rows={4}
          value={config.expression}
          onChange={v => onChange({ ...config, expression: v })}
          placeholder="e.g. state.score > 0.8"
        />
      ) : (
        <>
          <FormField
            label="Variable"
            value={config.variable}
            onChange={v => onChange({ ...config, variable: v })}
            placeholder="e.g. state.category"
          />
          <FormField
            label="Default Branch"
            value={config.defaultBranch}
            onChange={v => onChange({ ...config, defaultBranch: v })}
            placeholder="e.g. default"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Use JSON tab for complex switch conditions
          </p>
        </>
      )}
    </div>
  );
}

export default DecisionForm;
