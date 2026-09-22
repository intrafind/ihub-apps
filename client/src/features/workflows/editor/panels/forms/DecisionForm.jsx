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
          placeholder="e.g. $.data._docIndex < $.data._docsTotal"
          helpText="Reference state variables as $.data.<variable> (bare names like score are not recognized). Supports comparisons (>, >=, ==, ===, !=, <, <=), && / || / !, parentheses, and the helpers exists(), empty(), length() — e.g. length($.data._corpus) > 0."
        />
      ) : (
        <>
          <FormField
            label="Variable"
            value={config.variable}
            onChange={v => onChange({ ...config, variable: v })}
            placeholder="e.g. $.data.category"
            helpText="State path of the value to compare, written as $.data.<variable>."
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
